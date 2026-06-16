/**
 * Gulltoppr: typed client for the gulltoppr engine REST surface (SPEC §4).
 *
 * Low-level verbs mirror the seven engine verbs 1:1. A `contract()` helper gives a
 * viem-flavoured ergonomic surface (resolve once, then read/encode/simulate/prepare).
 */
import type { Address, Hex } from "viem";
import { AbiNinjaError, type ErrorCode } from "./errors.js";
import type {
  AbiResult,
  ChainInfo,
  ChainInput,
  CompactAbiResult,
  ContractInterface,
  DecodeTxResult,
  Discovery,
  EncodeResult,
  PreparedTx,
  Provenance,
  ReadResult,
  ReadCapability,
  ResolveNameResult,
  RuntimeMetrics,
  RegistryExportEntry,
  RegistryLookupResult,
  RegistryStats,
  Simulation,
  WalletRequest,
  WriteCapability,
} from "./types.js";

export interface GulltopprOptions {
  /** Engine base URL. Default: https://api.gulltoppr.dev */
  baseUrl?: string;
  /** Inject a custom fetch (tests, Node < 18, proxies). Default: global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Extra headers on every request (e.g. an API key). */
  headers?: Record<string, string>;
}

/** Backwards-compatible options alias. Prefer `GulltopprOptions` in new code. */
export type AbiNinjaOptions = GulltopprOptions;

export interface CallOpts {
  /** Override the RPC the engine uses for this chain (required for local/31337). */
  rpcUrl?: string;
}

export interface ResolveAbiOpts extends CallOpts {
  /** Include the raw JSON ABI. Default true for backwards compatibility. */
  includeAbi?: boolean;
  /** Server-side manifest method search; maps to REST method_q. */
  q?: string;
  /** Restrict the returned manifest to read or write methods. Default: all. */
  kind?: ContractMethodKind;
  /** Maximum number of manifest methods to return after filtering. */
  limit?: number;
}

export interface ChainListOpts {
  q?: string;
  testnets?: boolean;
  hasDefaultRpc?: boolean;
}

export type ContractMethodKind = "read" | "write" | "all";

export interface ContractMethodSearchOpts {
  /** Case-insensitive substring search across name, signature, parameter names/types, and hints. */
  q?: string;
  /** Restrict results to read or write methods. Default: all. */
  kind?: ContractMethodKind;
  /** Optional maximum number of flat matches to return. */
  limit?: number;
}

export type ContractMethodMatch =
  | { kind: "read"; method: ReadCapability }
  | { kind: "write"; method: WriteCapability };

export type SimulateArgs =
  | {
      from: Address;
      to: Address;
      data: Hex;
      value?: string;
    }
  | {
      from: Address;
      address: Address;
      function: string;
      args?: unknown[];
      value?: string;
    };

type MutableSimulateArgs = {
  from: Address;
  address?: Address;
  function?: string;
  args?: unknown[];
  to?: Address;
  data?: Hex;
  value?: string;
};

function invalidArgs(message: string): never {
  throw new AbiNinjaError("INVALID_ARGS", message, 0);
}

function requireAddress(name: string, value: unknown): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    invalidArgs(`\`${name}\` must be a 0x address.`);
  }
  return value as Address;
}

function requireFunctionName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    invalidArgs("`function` must be a non-empty string.");
  }
  return value;
}

function requireArgs(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalidArgs("`args` must be an array.");
  return value;
}

function optionalDecimalValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    invalidArgs("`value` must be a decimal string in wei.");
  }
  return value;
}

function optionalMethodKind(value: unknown): ContractMethodKind | undefined {
  if (value === undefined) return undefined;
  if (value === "read" || value === "write" || value === "all") return value;
  invalidArgs("`kind` must be read, write, or all.");
}

function optionalMethodLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 500) {
    invalidArgs("`limit` must be a non-negative integer <= 500.");
  }
  return value;
}

function optionalRpcUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") invalidArgs("`rpcUrl` must be an http(s) URL.");
  try {
    if (/\s/.test(value)) {
      invalidArgs("`rpcUrl` must be an http(s) URL.");
    }
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      invalidArgs("`rpcUrl` must be an http(s) URL.");
    }
    return value;
  } catch (error) {
    if (error instanceof AbiNinjaError) throw error;
    invalidArgs("`rpcUrl` must be an http(s) URL.");
  }
}

function requireHexData(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    invalidArgs("`data` must be 0x-prefixed hex bytes.");
  }
  return value as Hex;
}

function requireSelector(value: unknown): string {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{8}|[0-9a-fA-F]{64})$/.test(value)) {
    invalidArgs("`selector` must be 0x + 8 hex chars or 0x + 64 hex chars.");
  }
  return value.toLowerCase();
}

function requireTxHash(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    invalidArgs("`txHash` must be 0x + 64 hex chars.");
  }
  return value;
}

function methodHaystack(method: ReadCapability | WriteCapability): string {
  const outputs = "outputs" in method ? method.outputs : [];
  return [
    method.function,
    method.signature,
    method.hint,
    ...method.inputs.flatMap((param) => [param.name, param.type]),
    ...outputs.flatMap((param) => [param.name, param.type]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function methodMatches(method: ReadCapability | WriteCapability, query: string): boolean {
  if (!query) return true;
  const haystack = methodHaystack(method);
  if (haystack.includes(query)) return true;
  if (haystack.replace(/\s+/g, "").includes(query.replace(/\s+/g, ""))) return true;
  return query.split(/\s+/).every((token) => haystack.includes(token));
}

/** Search a capability manifest, returning flat method matches with their read/write kind. */
export function searchContractMethods(
  contractInterface: ContractInterface,
  opts: ContractMethodSearchOpts = {},
): ContractMethodMatch[] {
  const query = opts.q?.trim().toLowerCase() ?? "";
  const kind = opts.kind ?? "all";
  const limit = opts.limit == null ? undefined : Math.max(0, Math.floor(opts.limit));
  const matches: ContractMethodMatch[] = [];

  if (kind === "all" || kind === "read") {
    for (const method of contractInterface.reads) {
      if (methodMatches(method, query)) matches.push({ kind: "read", method });
    }
  }
  if (kind === "all" || kind === "write") {
    for (const method of contractInterface.writes) {
      if (methodMatches(method, query)) matches.push({ kind: "write", method });
    }
  }
  return limit === undefined ? matches : matches.slice(0, limit);
}

/** Filter a capability manifest while preserving the engine's `{ reads, writes }` shape. */
export function filterContractInterface(
  contractInterface: ContractInterface,
  opts: ContractMethodSearchOpts = {},
): ContractInterface {
  const matches = searchContractMethods(contractInterface, opts);
  return {
    reads: matches.filter((match): match is { kind: "read"; method: ReadCapability } => match.kind === "read").map((match) => match.method),
    writes: matches.filter((match): match is { kind: "write"; method: WriteCapability } => match.kind === "write").map((match) => match.method),
  };
}

export type ProvenanceWarningInput = {
  provenance: Provenance;
  proxy?: AbiResult["proxy"];
  abi_for?: Address;
  abi_omitted?: boolean;
};

export function isHighFrictionProvenance(provenance: Provenance): boolean {
  return provenance.names_synthetic || provenance.confidence === "decompiled" || provenance.confidence === "selector-only";
}

export function hasBytecodeMatch(
  provenance: Provenance,
): provenance is Provenance & { bytecode_match: NonNullable<Provenance["bytecode_match"]> } {
  return provenance.bytecode_match !== undefined;
}

export function provenanceWarnings(result: ProvenanceWarningInput): string[] {
  const warnings: string[] = [];
  const { provenance, proxy } = result;

  if (isHighFrictionProvenance(provenance)) {
    warnings.push(
      `Inferred ABI: names/mutability may be synthetic; confirm selector and intent before writes.${
        provenance.notes ? ` ${provenance.notes}` : ""
      }`,
    );
  }
  if (provenance.confidence === "partial") {
    warnings.push("Partial provenance: not verified-source ground truth for this exact address.");
  }
  if (hasBytecodeMatch(provenance)) {
    const match = provenance.bytecode_match;
    warnings.push(
      `Bytecode match: ABI reused from ${match.address} on chain ${match.chain} (${match.source}/${match.confidence}).`,
    );
  }
  if (proxy) {
    warnings.push(
      proxy.pattern === "diamond"
        ? `Diamond proxy: ABI is merged from ${proxy.hops.filter((hop) => hop.role === "facet").length} facet(s).`
        : `${proxy.pattern} proxy: ABI resolves against ${result.abi_for ?? proxy.resolved_implementation ?? "current implementation"}.`,
    );
  }
  if (result.abi_omitted) {
    warnings.push("Raw JSON ABI omitted for compact agent context.");
  }
  return warnings;
}

export class Gulltoppr {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headers: Record<string, string>;

  constructor(opts: GulltopprOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.gulltoppr.dev").replace(/\/$/, "");
    if (!opts.fetch && !globalThis.fetch) {
      throw new Error("No fetch available; pass { fetch } in GulltopprOptions.");
    }
    // Native browser fetch must be invoked with `this === window`/global; calling it
    // as a method (this.fetchImpl(...)) detaches it and throws "Illegal invocation".
    // Bind the default global fetch; leave a caller-provided fetch untouched.
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = opts.headers ?? {};
  }

  // ── verbs ───────────────────────────────────────────────────────────────────

  /** Root discovery document: REST/MCP links, verbs, utilities, and safety gate. */
  discovery(): Promise<Discovery> {
    return this.get("/");
  }

  /** Supported chain catalog, backed by viem/chains plus gulltoppr RPC overrides. */
  async chains(opts: ChainListOpts = {}): Promise<ChainInfo[]> {
    const params = new URLSearchParams();
    if (opts.q) params.set("q", opts.q);
    if (opts.testnets !== undefined) params.set("testnets", String(opts.testnets));
    if (opts.hasDefaultRpc !== undefined) params.set("has_default_rpc", String(opts.hasDefaultRpc));
    const qs = params.toString();
    const body = await this.get<{ chains: ChainInfo[] }>(`/v1/chains${qs ? `?${qs}` : ""}`);
    return body.chains;
  }

  /** Process-local resolver/RPC counters for reliability dashboards and smoke checks. */
  metrics(): Promise<RuntimeMetrics> {
    return this.get("/v1/metrics");
  }

  /** Lookup proven signatures for a 4-byte selector or 32-byte event topic. */
  lookupSelector(selector: string): Promise<RegistryLookupResult> {
    return this.get(`/v1/lookup/${encodeURIComponent(requireSelector(selector))}`);
  }

  /** Counts for the selector commons and bytecode-match index. */
  registryStats(): Promise<RegistryStats> {
    return this.get("/v1/registry/stats");
  }

  /** Full CC0 selector commons export, parsed from the engine's NDJSON response. */
  async exportRegistry(): Promise<RegistryExportEntry[]> {
    const text = await this.getText("/v1/registry/export");
    const trimmed = text.trim();
    if (!trimmed) return [];
    return trimmed.split("\n").map((line) => JSON.parse(line) as RegistryExportEntry);
  }

  /** resolve_abi: ABI + capability manifest + provenance + proxy chain. */
  resolveAbi(chain: ChainInput, address: Address, opts: ResolveAbiOpts & { includeAbi: false }): Promise<CompactAbiResult>;
  resolveAbi(chain: ChainInput, address: Address, opts?: ResolveAbiOpts): Promise<AbiResult>;
  resolveAbi(chain: ChainInput, address: Address, opts?: ResolveAbiOpts): Promise<AbiResult | CompactAbiResult> {
    return this.get(`/v1/${enc(chain)}/${requireAddress("address", address)}/abi`, opts);
  }

  /** Token-efficient resolve_abi: capability manifest + provenance without raw ABI. */
  resolveManifest(chain: ChainInput, address: Address, opts?: CallOpts & ContractMethodSearchOpts): Promise<CompactAbiResult> {
    return this.get(`/v1/${enc(chain)}/${requireAddress("address", address)}/abi`, { ...opts, includeAbi: false });
  }

  /** read_contract: call a view/pure function, get the decoded result. */
  read(chain: ChainInput, address: Address, fn: string, args: unknown[] = [], opts?: CallOpts): Promise<ReadResult> {
    return this.post(`/v1/${enc(chain)}/${requireAddress("address", address)}/read`, {
      function: requireFunctionName(fn),
      args: requireArgs(args),
    }, opts);
  }

  /** encode_call: function + args → calldata. */
  encode(
    chain: ChainInput,
    address: Address,
    fn: string,
    args: unknown[] = [],
    opts?: CallOpts & { value?: string },
  ): Promise<EncodeResult> {
    return this.post(`/v1/${enc(chain)}/${requireAddress("address", address)}/encode`, {
      function: requireFunctionName(fn),
      args: requireArgs(args),
      value: optionalDecimalValue(opts?.value),
    }, opts);
  }

  /** simulate: high-level {address,function,args} or raw {to,data}. */
  simulate(chain: ChainInput, args: SimulateArgs, opts?: CallOpts): Promise<Simulation> {
    const body = args as MutableSimulateArgs;
    const value = optionalDecimalValue(body.value);
    const from = requireAddress("from", body.from);
    const hasRaw = body.to !== undefined || body.data !== undefined;
    const hasHighLevel = body.address !== undefined || body.function !== undefined || body.args !== undefined;

    if (hasRaw && hasHighLevel) {
      invalidArgs("simulate accepts either raw {to,data} or high-level {address,function,args}, not both.");
    }
    if (hasRaw) {
      return this.post(`/v1/${enc(chain)}/simulate`, {
        from,
        to: requireAddress("to", body.to),
        data: requireHexData(body.data),
        value,
      }, opts);
    }
    if (hasHighLevel) {
      return this.post(`/v1/${enc(chain)}/simulate`, {
        from,
        address: requireAddress("address", body.address),
        function: requireFunctionName(body.function),
        args: body.args === undefined ? [] : requireArgs(body.args),
        value,
      }, opts);
    }
    invalidArgs("simulate needs either {to,data} or {address,function,args}.");
  }

  /** prepare_tx, the non-custodial hand-off: unsigned tx + simulation + summary + deeplink/wallet request. */
  prepareTx(
    chain: ChainInput,
    address: Address,
    fn: string,
    args: unknown[],
    opts: CallOpts & { from: Address; value?: string },
  ): Promise<PreparedTx> {
    return this.post(`/v1/${enc(chain)}/${requireAddress("address", address)}/prepare`, {
      function: requireFunctionName(fn),
      args: requireArgs(args),
      from: requireAddress("from", opts.from),
      value: optionalDecimalValue(opts.value),
    }, opts);
  }

  /** decode_tx: "explain what this tx did." */
  decodeTx(chain: ChainInput, txHash: string, opts?: CallOpts): Promise<DecodeTxResult> {
    return this.get(`/v1/${enc(chain)}/tx/${requireTxHash(txHash)}`, opts);
  }

  /** resolve_name: ENS/Basename → address, or address → primary ENS/Basename for a chain. */
  resolveName(nameOrAddress: string, chain: ChainInput = "ethereum"): Promise<ResolveNameResult> {
    const isAddr = /^0x[0-9a-fA-F]{40}$/.test(nameOrAddress);
    const path = isAddr
      ? `/v1/${enc(chain)}/name/by-address/${nameOrAddress}`
      : `/v1/${enc(chain)}/name/${encodeURIComponent(nameOrAddress)}`;
    return this.get(path);
  }

  /** Ergonomic handle: resolve once, then read/encode/prepare against this contract. */
  contract(chain: ChainInput, address: Address): Contract {
    return new Contract(this, chain, address);
  }

  // ── transport ─────────────────────────────────────────────────────────────────

  private url(path: string, opts?: CallOpts | ResolveAbiOpts): string {
    const u = new URL(this.baseUrl + path);
    const rpcUrl = optionalRpcUrl(opts?.rpcUrl);
    if (rpcUrl) u.searchParams.set("rpc_url", rpcUrl);
    if ("includeAbi" in (opts ?? {}) && (opts as ResolveAbiOpts).includeAbi !== undefined) {
      u.searchParams.set("include_abi", String((opts as ResolveAbiOpts).includeAbi));
    }
    const methodQuery = (opts as ResolveAbiOpts | undefined)?.q?.trim();
    if (methodQuery) u.searchParams.set("method_q", methodQuery);
    const methodKind = optionalMethodKind((opts as ResolveAbiOpts | undefined)?.kind);
    if (methodKind) u.searchParams.set("method_kind", methodKind);
    const methodLimit = optionalMethodLimit((opts as ResolveAbiOpts | undefined)?.limit);
    if (methodLimit !== undefined) u.searchParams.set("method_limit", String(methodLimit));
    return u.toString();
  }

  private async get<T>(path: string, opts?: CallOpts | ResolveAbiOpts): Promise<T> {
    return this.request<T>("GET", this.url(path, opts));
  }

  private async getText(path: string, opts?: CallOpts | ResolveAbiOpts): Promise<string> {
    return this.requestText("GET", this.url(path, opts));
  }

  private async post<T>(path: string, body: unknown, opts?: CallOpts): Promise<T> {
    return this.request<T>("POST", this.url(path, opts), body);
  }

  private async request<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
    const text = await this.requestText(method, url, body);
    const json = text ? (JSON.parse(text) as unknown) : undefined;
    return json as T;
  }

  private async requestText(method: "GET" | "POST", url: string, body?: unknown): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { "content-type": "application/json", ...this.headers },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      throw new AbiNinjaError("NETWORK", `Request to ${url} failed: ${(e as Error).message}`, 0);
    }

    const text = await res.text();
    let json: unknown;
    try {
      json = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      json = undefined;
    }

    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })?.error;
      throw new AbiNinjaError(
        (err?.code as ErrorCode) ?? "INTERNAL",
        err?.message ?? `HTTP ${res.status}`,
        res.status,
        err?.details,
      );
    }
    return text;
  }
}

/** Backwards-compatible client name. Prefer `Gulltoppr` in new code. */
export class AbiNinja extends Gulltoppr {}

function preparedTxSafety(prep: PreparedTx): PreparedTx["safety"] | undefined {
  const safety = (prep as Partial<PreparedTx>).safety;
  if (!safety || typeof safety !== "object") return undefined;
  if (typeof safety.signing_recommended !== "boolean") return undefined;
  if (typeof safety.risk_level !== "string") return undefined;
  if (typeof safety.requires_human_confirmation !== "boolean") return undefined;
  if (!Array.isArray(safety.reasons)) return undefined;
  return safety;
}

function requirePreparedTxSafety(prep: PreparedTx): PreparedTx["safety"] {
  const safety = preparedTxSafety(prep);
  if (!safety) {
    throw new AbiNinjaError(
      "INVALID_ARGS",
      "prepare_tx response did not include safety metadata; refusing wallet hand-off.",
      0,
    );
  }
  return safety;
}

/** Return the EIP-1193 hand-off only when prepare_tx says signing is safe to present. */
export function requireWalletRequest(prep: PreparedTx): WalletRequest {
  const safety = requirePreparedTxSafety(prep);
  if (!safety.signing_recommended) {
    throw new AbiNinjaError(
      "INVALID_ARGS",
      `prepare_tx safety does not recommend signing (risk=${safety.risk_level}).`,
      0,
      { risk_level: safety.risk_level, reasons: safety.reasons },
    );
  }
  if (!prep.wallet_request) {
    throw new AbiNinjaError(
      "INVALID_ARGS",
      "prepare_tx did not include wallet_request; use unsigned_tx/deeplink or upgrade the engine.",
      0,
      { risk_level: safety.risk_level, reasons: safety.reasons },
    );
  }
  return prep.wallet_request;
}

/** True only for writes that need no extra human confirmation before wallet hand-off. */
export function isLowRiskPreparedTx(prep: PreparedTx): boolean {
  const safety = preparedTxSafety(prep);
  if (!safety) return false;
  return (
    safety.signing_recommended &&
    safety.risk_level === "low" &&
    !safety.requires_human_confirmation &&
    safety.reasons.length === 0
  );
}

/**
 * Return the EIP-1193 hand-off only for low-risk writes. Use this in automated
 * app flows that should stop on approvals, asset outflows, proxies, inferred ABI
 * names, native value, or failed simulation.
 */
export function requireLowRiskWalletRequest(prep: PreparedTx): WalletRequest {
  const safety = requirePreparedTxSafety(prep);
  if (!isLowRiskPreparedTx(prep)) {
    throw new AbiNinjaError(
      "INVALID_ARGS",
      `prepare_tx requires human confirmation (risk=${safety.risk_level}).`,
      0,
      {
        risk_level: safety.risk_level,
        reasons: safety.reasons,
        signing_recommended: safety.signing_recommended,
      },
    );
  }
  return requireWalletRequest(prep);
}

/** A resolved-on-demand handle to one contract, viem `getContract` flavour. */
export class Contract {
  private readonly resolvedByRpcUrl = new Map<string, Promise<AbiResult>>();

  constructor(
    private readonly client: Gulltoppr,
    readonly chain: ChainInput,
    readonly address: Address,
  ) {}

  /** Resolve (and memoize) this contract's ABI + manifest. */
  resolve(opts?: CallOpts): Promise<AbiResult> {
    const cacheKey = opts?.rpcUrl ?? "";
    const cached = this.resolvedByRpcUrl.get(cacheKey);
    if (cached) return cached;

    const pending = this.client.resolveAbi(this.chain, this.address, opts).catch((error) => {
      if (this.resolvedByRpcUrl.get(cacheKey) === pending) {
        this.resolvedByRpcUrl.delete(cacheKey);
      }
      throw error;
    });
    this.resolvedByRpcUrl.set(cacheKey, pending);
    return pending;
  }

  read(fn: string, args: unknown[] = [], opts?: CallOpts): Promise<ReadResult> {
    return this.client.read(this.chain, this.address, fn, args, opts);
  }

  encode(fn: string, args: unknown[] = [], opts?: CallOpts & { value?: string }): Promise<EncodeResult> {
    return this.client.encode(this.chain, this.address, fn, args, opts);
  }

  simulate(fn: string, args: unknown[], opts: CallOpts & { from: Address; value?: string }): Promise<Simulation> {
    return this.client.simulate(this.chain, {
      from: opts.from,
      address: this.address,
      function: fn,
      args,
      value: opts.value,
    }, opts);
  }

  prepare(fn: string, args: unknown[], opts: CallOpts & { from: Address; value?: string }): Promise<PreparedTx> {
    return this.client.prepareTx(this.chain, this.address, fn, args, opts);
  }
}

/** Chain segment: numbers and alias strings both pass through encodeURIComponent. */
function enc(chain: ChainInput): string {
  return encodeURIComponent(String(chain));
}
