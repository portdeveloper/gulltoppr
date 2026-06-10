/**
 * resolve_abi — the ladder orchestrator and the spine of the engine (SPEC §3, §8).
 * Every other verb resolves an ABI through here first.
 *
 * Order: proxy detection runs FIRST (cheap storage reads) to find the address whose
 * ABI is actually interactive — for a proxy we want the implementation's ABI, not
 * the proxy shell's. We then run the source rungs (Etherscan → Sourcify → heimdall →
 * 4byte) on that target. Provenance records which rung won and is capped to
 * `partial` behind a proxy (storage layout / live impl is an assumption).
 */
import { getAddress, type Abi, type Address, type PublicClient } from "viem";
import { ApiError } from "../errors.js";
import type {
  AbiResult,
  Confidence,
  Provenance,
  ProxyChain,
  ResolvedAbi,
  TokenMeta,
} from "../types.js";
import { getClient } from "../clients.js";
import { JsonCache } from "../cache.js";
import { abiFunctions, buildInterface } from "./interface.js";
import { fromEtherscan } from "./etherscan.js";
import { fromSourcify } from "./sourcify.js";
import { detectProxy } from "./proxy.js";
import { fromHeimdall } from "./heimdall.js";
import { fromFourByte } from "./fourbyte.js";

export function normalizeAddress(raw: string): Address {
  try {
    return getAddress(raw);
  } catch {
    throw new ApiError("INVALID_ADDRESS", `Not a valid address: "${raw}"`);
  }
}

/** Run the source rungs (no proxy logic) on a single address. */
async function resolveSource(
  client: PublicClient,
  chainId: number,
  address: Address,
  rpcUrl: string,
): Promise<{ abi: Abi; provenance: Provenance; cached: boolean }> {
  // Rung 1 — Etherscan v2.
  const es = await fromEtherscan(chainId, address);
  if (es) {
    return {
      abi: es.abi,
      cached: false,
      provenance: {
        source: "etherscan",
        confidence: "verified",
        verified: true,
        names_synthetic: false,
        natspec: es.natspec,
      },
    };
  }

  // Rung 2 — Sourcify.
  const sc = await fromSourcify(chainId, address);
  if (sc) {
    const confidence: Confidence = sc.match === "full" ? "verified" : "partial";
    return {
      abi: sc.abi,
      cached: false,
      provenance: {
        source: "sourcify",
        confidence,
        verified: sc.match === "full",
        names_synthetic: false,
        natspec: true,
        ...(sc.match === "partial" ? { notes: "Sourcify partial match." } : {}),
      },
    };
  }

  // Rung 4 — heimdall via gulltoppr (the moat).
  const hd = await fromHeimdall(address, rpcUrl);
  if (hd) {
    return {
      abi: hd.abi,
      cached: hd.cached,
      provenance: {
        source: "heimdall-decompiled",
        confidence: "decompiled",
        verified: false,
        names_synthetic: true,
        natspec: false,
        notes: "Decompiled by heimdall; function/param names are inferred — verify intent before acting.",
      },
    };
  }

  // Rung 5 — 4byte selector DB (currently stubbed).
  const fb = await fromFourByte(address, rpcUrl);
  if (fb) {
    return {
      abi: fb,
      cached: false,
      provenance: {
        source: "4byte",
        confidence: "selector-only",
        verified: false,
        names_synthetic: true,
        natspec: false,
        notes: "Per-function selector matches only; not a full ABI.",
      },
    };
  }

  throw new ApiError("ABI_NOT_FOUND", "No ABI from any rung (Etherscan, Sourcify, heimdall, 4byte).");
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
      client.readContract({ address, abi: erc20, functionName: "decimals" }).catch(() => undefined),
      client.readContract({ address, abi: erc20, functionName: "symbol" }).catch(() => undefined),
      client.readContract({ address, abi: erc20, functionName: "name" }).catch(() => undefined),
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

  const code = await client.getCode({ address }).catch((e) => {
    throw new ApiError("RPC_ERROR", `RPC getCode failed: ${(e as Error).message}`);
  });
  if (!code || code === "0x") {
    throw new ApiError("ABI_NOT_FOUND", "No contract bytecode at this address (EOA or not deployed).");
  }

  // Proxy detection first → pick the interactive target address.
  const proxy = await detectProxy(client, address);
  const target = proxy ? proxy.implementation : address;

  const src = await resolveSource(client, resolved.id, target, resolved.rpcUrl);

  let provenance = src.provenance;
  let proxyChain: ProxyChain | undefined;
  if (proxy) {
    // Behind a proxy: max confidence is `partial` (storage layout / live impl assumed).
    const confidence: Confidence = src.provenance.confidence === "verified" ? "partial" : src.provenance.confidence;
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

/** Result cache for resolve_abi, keyed by `${chainId}:${address}`. */
const abiCache = new JsonCache<AbiResult>("abi:");

/** TTL by provenance: proxies can be upgraded (short); decompiled ABIs are
 * deterministic per bytecode (long); verified/partial are stable but cheap to refresh. */
function ttlFor(r: AbiResult): number {
  if (r.proxy) return 300; // implementation may be upgraded out from under us
  if (r.provenance.names_synthetic) return 86_400; // decompiled / selector-only
  return 3_600; // verified / partial
}

/** Public resolve_abi: the full AbiResult with the capability manifest as headline. */
export async function resolveAbi(
  chainInput: number | string,
  rawAddress: string,
  rpcOverride?: string,
): Promise<AbiResult> {
  const address = normalizeAddress(rawAddress);
  const { resolved } = getClient(chainInput, rpcOverride); // resolves chain id (no network)
  const key = `${resolved.id}:${address}`;

  const hit = abiCache.get(key);
  if (hit) return { ...hit, cached: true };

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
  abiCache.set(key, result, ttlFor(result));
  return result;
}
