/**
 * resolve_abi — the ladder orchestrator and the spine of the engine (SPEC §3, §8).
 * Every other verb resolves an ABI through here first.
 *
 * Order: proxy detection runs FIRST (cheap storage reads) to find the address whose
 * ABI is actually interactive — for a classic proxy we want the implementation's
 * ABI, not the proxy shell's. Diamonds are special: EIP-2535 has multiple facets,
 * so we merge the active facet functions by selector. Provenance records which
 * rung won and is capped behind a proxy (storage layout / live impl is an assumption).
 */
import { getAddress, toFunctionSelector, type Abi, type AbiFunction, type Address, type Hex, type PublicClient } from "viem";
import { ApiError } from "../errors.js";
import type {
  AbiResult,
  Confidence,
  CompactAbiResult,
  Provenance,
  ProxyChain,
  ResolvedAbi,
  TokenMeta,
} from "../types.js";
import { getClient } from "../clients.js";
import { JsonCache } from "../cache.js";
import { chainRpcCacheScope } from "../cacheKey.js";
import { abiFunctions, buildInterface } from "./interface.js";
import { fromEtherscan } from "./etherscan.js";
import { fromSourcify } from "./sourcify.js";
import { detectProxy, type DiamondFacet } from "./proxy.js";
import { fromHeimdall } from "./heimdall.js";
import { fromFourByte } from "./fourbyte.js";
import { skeletonHash } from "../registry/normalize.js";
import { registry } from "../registry/store.js";
import { enrichDecompiledAbi } from "../registry/enrich.js";
import { proposeAndVerify } from "../registry/propose.js";
import { trackBestEffortMetric, trackMetric } from "../metrics.js";

export function normalizeAddress(raw: string): Address {
  try {
    return getAddress(raw);
  } catch {
    throw new ApiError("INVALID_ADDRESS", `Not a valid address: "${raw}"`);
  }
}

/** Run the source rungs (no proxy logic) on a single address.
 * `knownCode` saves a getCode round-trip when the caller already fetched it. */
async function resolveSource(
  client: PublicClient,
  chainId: number,
  address: Address,
  rpcUrl: string,
  knownCode?: `0x${string}`,
): Promise<{ abi: Abi; provenance: Provenance; cached: boolean }> {
  // Skeleton hash (metadata-stripped bytecode) — the registry's clone key.
  const code =
    knownCode ??
    (await trackMetric(
      "rpc.getCode",
      () => client.getCode({ address }),
      (value) => (value && value !== "0x" ? "success" : "miss"),
    ).catch(() => undefined));
  const skeleton = code && code !== "0x" ? skeletonHash(code) : undefined;

  const recordBytecode = (abi: Abi, p: Provenance) => {
    if (!skeleton) return;
    registry.recordBytecode({
      skeleton_hash: skeleton,
      abi,
      source: p.source,
      confidence: p.confidence,
      names_synthetic: p.names_synthetic,
      chain: chainId,
      address,
    });
  };

  // Rung 1 — Etherscan v2.
  const es = await trackMetric("rung.etherscan", () => fromEtherscan(chainId, address)).catch(() => null);
  if (es) {
    const provenance: Provenance = {
      source: "etherscan",
      confidence: "verified",
      verified: true,
      names_synthetic: false,
      natspec: es.natspec,
    };
    registry.recordVerifiedAbi(chainId, address, es.abi); // seed the commons (ground truth)
    recordBytecode(es.abi, provenance);
    return { abi: es.abi, cached: false, provenance };
  }

  // Rung 2 — Sourcify.
  const sc = await trackMetric("rung.sourcify", () => fromSourcify(chainId, address)).catch(() => null);
  if (sc) {
    const confidence: Confidence = sc.match === "full" ? "verified" : "partial";
    const provenance: Provenance = {
      source: "sourcify",
      confidence,
      verified: sc.match === "full",
      names_synthetic: false,
      natspec: true,
      ...(sc.match === "partial" ? { notes: "Sourcify partial match." } : {}),
    };
    registry.recordVerifiedAbi(chainId, address, sc.abi); // names come from source either way
    recordBytecode(sc.abi, provenance);
    return { abi: sc.abi, cached: false, provenance };
  }

  // Rung 3.5 — bytecode match: an identical skeleton was resolved before
  // (clone of a token/safe/factory product). Reuse its ABI; verified claims are
  // capped to `partial` because *this* address's source was never verified.
  if (skeleton) {
    const hit = registry.getBytecode(skeleton);
    if (hit) {
      const enriched = hit.names_synthetic ? enrichDecompiledAbi(hit.abi) : { abi: hit.abi, recovered: 0 };
      return {
        abi: enriched.abi,
        cached: true,
        provenance: {
          source: "bytecode-match",
          confidence: hit.names_synthetic ? hit.confidence : "partial",
          verified: false,
          names_synthetic: hit.names_synthetic,
          natspec: false,
          bytecode_match: {
            chain: hit.chain,
            address: hit.address,
            source: hit.source,
            confidence: hit.confidence,
          },
          notes:
            `Identical runtime bytecode (metadata-stripped) previously resolved at ${hit.address} on chain ${hit.chain} ` +
            `(${hit.source}/${hit.confidence}).` +
            (enriched.recovered ? ` ${enriched.recovered} function name(s) recovered from the registry.` : ""),
        },
      };
    }
  }

  // Rung 4 — heimdall via heimdall-api (the moat).
  const hd = await trackMetric("rung.heimdall", () => fromHeimdall(address, rpcUrl)).catch(() => null);
  if (hd) {
    const enriched = enrichDecompiledAbi(hd.abi); // proven registry names replace Unresolved_*
    const provenance: Provenance = {
      source: "heimdall-decompiled",
      confidence: "decompiled",
      verified: false,
      names_synthetic: true,
      natspec: false,
      notes:
        "Decompiled by heimdall; function/param names are inferred — verify intent before acting." +
        (enriched.recovered ? ` ${enriched.recovered} function name(s) recovered from the registry (signature-proven).` : ""),
    };
    recordBytecode(enriched.abi, provenance);
    // Fire-and-forget: LLM propose-and-verify on still-unresolved selectors
    // (env-gated; no-op without ANTHROPIC_API_KEY). Never blocks the response.
    proposeAndVerify(enriched.abi, { chain: chainId, address }).catch(() => {});
    return { abi: enriched.abi, cached: hd.cached, provenance };
  }

  // Rung 5 — selector-level fallback: dispatcher PUSH4 scan, named registry-first
  // (proven), then 4byte.directory (unproven). Fires only when heimdall fails.
  const fb = await trackMetric("rung.4byte", () => fromFourByte(code));
  if (fb) {
    const { registry: nReg, fourbyte: n4b, unresolved: nUn } = fb.counts;
    return {
      abi: fb.abi,
      cached: false,
      provenance: {
        source: "4byte",
        confidence: "selector-only",
        verified: false,
        names_synthetic: true,
        natspec: false,
        notes:
          `Selector-level only — not a full ABI (mutability/outputs unknown). Names: ${nReg} proven from the registry, ` +
          `${n4b} from 4byte.directory (unproven, may be misleading), ${nUn} unresolved.`,
      },
    };
  }

  throw new ApiError("ABI_NOT_FOUND", "No ABI from any rung (Etherscan, Sourcify, heimdall, 4byte).");
}

function confidenceScore(confidence: Confidence): number {
  return { verified: 0, partial: 1, decompiled: 2, "selector-only": 3 }[confidence];
}

function weakerConfidence(a: Confidence, b: Confidence): Confidence {
  return confidenceScore(a) >= confidenceScore(b) ? a : b;
}

function capProxyConfidence(confidence: Confidence): Confidence {
  return confidence === "verified" ? "partial" : confidence;
}

function mergeFacetAbi(
  abi: Abi,
  selectors: Set<string>,
  seenFunctions: Set<string>,
  seenOther: Set<string>,
): { items: Abi; matchedFunctions: number } {
  const items: Abi[number][] = [];
  let matchedFunctions = 0;
  for (const item of abi) {
    if (item.type === "function") {
      const selector = toFunctionSelector(item as AbiFunction).toLowerCase();
      if (!selectors.has(selector) || seenFunctions.has(selector)) continue;
      seenFunctions.add(selector);
      items.push(item);
      matchedFunctions++;
      continue;
    }
    if (item.type !== "event" && item.type !== "error") continue;
    const key = JSON.stringify(item);
    if (seenOther.has(key)) continue;
    seenOther.add(key);
    items.push(item);
  }
  return { items: items as Abi, matchedFunctions };
}

async function resolveDiamondSource(
  client: PublicClient,
  chainId: number,
  address: Address,
  rpcUrl: string,
  facets: DiamondFacet[],
): Promise<{ abi: Abi; provenance: Provenance; proxy: ProxyChain; abiFor: Address; cached: boolean }> {
  const mergedAbi: Abi[number][] = [];
  const seenFunctions = new Set<string>();
  const seenOther = new Set<string>();
  const unresolvedFacets: Address[] = [];
  const provenanceNotes: string[] = [];
  let resolvedFacets = 0;
  let matchedFunctions = 0;
  let totalSelectors = 0;
  let confidence: Confidence = "verified";
  let namesSynthetic = false;
  let natspec = false;
  let allCached = true;

  for (const facet of facets) {
    const selectors = new Set(facet.selectors.map((selector: Hex) => selector.toLowerCase()));
    totalSelectors += selectors.size;
    let src: Awaited<ReturnType<typeof resolveSource>>;
    try {
      src = await resolveSource(client, chainId, facet.address, rpcUrl);
    } catch {
      unresolvedFacets.push(facet.address);
      continue;
    }

    const merged = mergeFacetAbi(src.abi, selectors, seenFunctions, seenOther);
    mergedAbi.push(...merged.items);
    matchedFunctions += merged.matchedFunctions;
    resolvedFacets++;
    confidence = weakerConfidence(confidence, src.provenance.confidence);
    namesSynthetic ||= src.provenance.names_synthetic;
    natspec ||= src.provenance.natspec;
    allCached &&= src.cached;
    if (src.provenance.notes) provenanceNotes.push(src.provenance.notes);
  }

  if (matchedFunctions === 0) {
    throw new ApiError(
      "ABI_NOT_FOUND",
      "Diamond proxy detected, but no active facet functions could be resolved from verified, decompiled, or selector ABIs.",
    );
  }

  const unresolvedSelectors = Math.max(totalSelectors - seenFunctions.size, 0);
  const notes = [
    `Resolved via diamond proxy; merged ${matchedFunctions} active selector(s) from ${resolvedFacets}/${facets.length} resolved facet ABI(s).`,
    unresolvedFacets.length ? `${unresolvedFacets.length} facet(s) could not be resolved.` : undefined,
    unresolvedSelectors ? `${unresolvedSelectors} selector(s) were not present in resolved facet ABIs.` : undefined,
    ...provenanceNotes,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    abi: mergedAbi as Abi,
    cached: allCached,
    provenance: {
      source: "proxy-impl",
      confidence: capProxyConfidence(confidence),
      verified: false,
      names_synthetic: namesSynthetic,
      natspec,
      notes,
    },
    proxy: {
      is_proxy: true,
      pattern: "diamond",
      hops: [{ address, role: "proxy" }, ...facets.map((facet) => ({ address: facet.address, role: "facet" as const }))],
    },
    abiFor: address,
  };
}

/** Best-effort token metadata for hints (SPEC §2.4 token / §2.4a hints). */
async function detectToken(client: PublicClient, address: Address): Promise<TokenMeta | undefined> {
  const erc20 = [
    { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
    { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
    { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  ] as const;
  try {
    const [decimals, symbol, name] = await Promise.all([
      trackBestEffortMetric(
        "rpc.readContract.token.decimals",
        () => client.readContract({ address, abi: erc20, functionName: "decimals" }),
        () => undefined,
      ),
      trackBestEffortMetric(
        "rpc.readContract.token.symbol",
        () => client.readContract({ address, abi: erc20, functionName: "symbol" }),
        () => undefined,
      ),
      trackBestEffortMetric(
        "rpc.readContract.token.name",
        () => client.readContract({ address, abi: erc20, functionName: "name" }),
        () => undefined,
      ),
    ]);
    if (decimals !== undefined) {
      return { kind: "erc20", decimals: Number(decimals), symbol: symbol as string | undefined, name: name as string | undefined };
    }
  } catch {
    /* not erc20 */
  }
  return undefined;
}

/** Internal resolve used by the verbs: returns abi + selectable functions + provenance. */
export async function resolveAbiInternal(
  chainInput: number | string,
  rawAddress: string,
  rpcOverride?: string,
): Promise<ResolvedAbi & { chainId: number; client: PublicClient; rpcUrl: string }> {
  const { client, resolved } = getClient(chainInput, rpcOverride);
  const address = normalizeAddress(rawAddress);

  const code = await trackMetric(
    "rpc.getCode",
    () => client.getCode({ address }),
    (value) => (value && value !== "0x" ? "success" : "miss"),
  ).catch((e) => {
    throw new ApiError("RPC_ERROR", `RPC getCode failed: ${(e as Error).message}`);
  });
  if (!code || code === "0x") {
    throw new ApiError("ABI_NOT_FOUND", "No contract bytecode at this address (EOA or not deployed).");
  }

  // Proxy detection first → pick the interactive target address.
  const proxy = await trackMetric("rung.proxy_detection", () => detectProxy(client, address));
  if (proxy?.pattern === "diamond") {
    const src = await resolveDiamondSource(client, resolved.id, address, resolved.rpcUrl, proxy.facets);
    return {
      abi: src.abi,
      functions: abiFunctions(src.abi),
      provenance: src.provenance,
      proxy: src.proxy,
      abiFor: src.abiFor,
      cached: src.cached,
      chainId: resolved.id,
      client,
      rpcUrl: resolved.rpcUrl,
    };
  }
  const target = proxy ? proxy.implementation : address;

  const src = await resolveSource(client, resolved.id, target, resolved.rpcUrl, target === address ? code : undefined);

  let provenance = src.provenance;
  let proxyChain: ProxyChain | undefined;
  if (proxy) {
    // Behind a proxy: max confidence is `partial` (storage layout / live impl assumed).
    const confidence = capProxyConfidence(src.provenance.confidence);
    provenance = {
      ...src.provenance,
      source: "proxy-impl",
      confidence,
      verified: false,
      notes: [`Resolved via ${proxy.pattern} proxy → implementation ${target}.`, src.provenance.notes]
        .filter(Boolean)
        .join(" "),
    };
    proxyChain = {
      is_proxy: true,
      pattern: proxy.pattern,
      hops: [
        { address, role: "proxy" },
        ...(proxy.beacon ? [{ address: proxy.beacon, role: "beacon" as const }] : []),
        { address: target, role: "implementation" },
      ],
      resolved_implementation: target,
    };
  }

  return {
    abi: src.abi,
    functions: abiFunctions(src.abi),
    provenance,
    proxy: proxyChain,
    abiFor: target,
    cached: src.cached,
    chainId: resolved.id,
    client,
    rpcUrl: resolved.rpcUrl,
  };
}

/** Result cache for resolve_abi, scoped by chain id + RPC URL hash + address.
 * The RPC hash prevents private/local chains with the same EIP-155 id from
 * sharing ABI results, without persisting raw RPC URLs or API keys in cache keys. */
const abiCache = new JsonCache<AbiResult>("abi:");

/** TTL by provenance, aligned with the public Cache-Control contract. */
export function cacheTtlForAbi(r: Pick<AbiResult, "proxy" | "provenance">): number {
  if (r.proxy) return 300; // implementation may be upgraded out from under us
  if (r.provenance.confidence === "verified") return 86_400;
  return 3_600; // partial / decompiled / selector-only
}

/** Public resolve_abi: the full AbiResult with the capability manifest as headline. */
export async function resolveAbi(
  chainInput: number | string,
  rawAddress: string,
  rpcOverride?: string,
): Promise<AbiResult> {
  const address = normalizeAddress(rawAddress);
  const { resolved } = getClient(chainInput, rpcOverride); // resolves chain id (no network)
  const key = `${chainRpcCacheScope(resolved.id, resolved.rpcUrl)}:${address}`;

  const hit = abiCache.get(key);
  if (hit) {
    // Cache hits still feed the selector commons: entries cached before the
    // registry existed would otherwise never be harvested. Idempotent
    // (INSERT OR IGNORE) and needs no RPC; the bytecode index is skipped here
    // because it would require a getCode round-trip.
    if (!hit.provenance.names_synthetic) registry.recordVerifiedAbi(hit.chain, address, hit.abi);
    return { ...hit, cached: true };
  }

  const r = await resolveAbiInternal(chainInput, rawAddress, rpcOverride);
  const token = await detectToken(r.client, address);

  const result: AbiResult = {
    chain: r.chainId,
    address,
    interface: buildInterface(r.abi, r.provenance, token),
    abi: r.abi,
    provenance: r.provenance,
    ...(r.proxy ? { proxy: r.proxy } : {}),
    ...(token ? { token } : {}),
    abi_for: r.abiFor,
    cached: r.cached,
  };
  abiCache.set(key, result, cacheTtlForAbi(result));
  return result;
}

export function compactAbiResult(result: AbiResult): CompactAbiResult {
  const { abi: _abi, ...rest } = result;
  return { ...rest, abi_omitted: true };
}
