/**
 * AbiNinja: typed client for the gulltoppr engine REST surface (SPEC §4).
 *
 * Low-level verbs mirror the seven engine verbs 1:1. A `contract()` helper gives a
 * viem-flavoured ergonomic surface (resolve once, then read/encode/prepare).
 */
import type { Address, Hex } from "viem";
import { AbiNinjaError, type ErrorCode } from "./errors.js";
import type {
  AbiResult,
  ChainInfo,
  ChainInput,
  DecodeTxResult,
  EncodeResult,
  PreparedTx,
  ReadResult,
  ResolveNameResult,
  Simulation,
} from "./types.js";

export interface AbiNinjaOptions {
  /** Engine base URL. Default: https://api.gulltoppr.dev */
  baseUrl?: string;
  /** Inject a custom fetch (tests, Node < 18, proxies). Default: global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Extra headers on every request (e.g. an API key). */
  headers?: Record<string, string>;
}

export interface CallOpts {
  /** Override the RPC the engine uses for this chain (required for local/31337). */
  rpcUrl?: string;
}

interface SimulateArgs {
  from: Address;
  // high-level form:
  address?: Address;
  function?: string;
  args?: unknown[];
  // raw form:
  to?: Address;
  data?: Hex;
  value?: string;
}

export class AbiNinja {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headers: Record<string, string>;

  constructor(opts: AbiNinjaOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "https://api.gulltoppr.dev").replace(/\/$/, "");
    if (!opts.fetch && !globalThis.fetch) {
      throw new Error("No fetch available; pass { fetch } in AbiNinjaOptions.");
    }
    // Native browser fetch must be invoked with `this === window`/global; calling it
    // as a method (this.fetchImpl(...)) detaches it and throws "Illegal invocation".
    // Bind the default global fetch; leave a caller-provided fetch untouched.
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = opts.headers ?? {};
  }

  // ── verbs ───────────────────────────────────────────────────────────────────

  /** Supported chain catalog, backed by viem/chains plus gulltoppr RPC overrides. */
  async chains(): Promise<ChainInfo[]> {
    const body = await this.get<{ chains: ChainInfo[] }>("/v1/chains");
    return body.chains;
  }

  /** resolve_abi: ABI + capability manifest + provenance + proxy chain. */
  resolveAbi(chain: ChainInput, address: Address, opts?: CallOpts): Promise<AbiResult> {
    return this.get(`/v1/${enc(chain)}/${address}/abi`, opts);
  }

  /** read_contract: call a view/pure function, get the decoded result. */
  read(chain: ChainInput, address: Address, fn: string, args: unknown[] = [], opts?: CallOpts): Promise<ReadResult> {
    return this.post(`/v1/${enc(chain)}/${address}/read`, { function: fn, args }, opts);
  }

  /** encode_call: function + args → calldata. */
  encode(
    chain: ChainInput,
    address: Address,
    fn: string,
    args: unknown[] = [],
    opts?: CallOpts & { value?: string },
  ): Promise<EncodeResult> {
    return this.post(`/v1/${enc(chain)}/${address}/encode`, { function: fn, args, value: opts?.value }, opts);
  }

  /** simulate: high-level {address,function,args} or raw {to,data}. */
  simulate(chain: ChainInput, args: SimulateArgs, opts?: CallOpts): Promise<Simulation> {
    return this.post(`/v1/${enc(chain)}/simulate`, args, opts);
  }

  /** prepare_tx, the non-custodial hand-off: unsigned tx + simulation + summary + deeplink. */
  prepareTx(
    chain: ChainInput,
    address: Address,
    fn: string,
    args: unknown[],
    opts: CallOpts & { from: Address; value?: string },
  ): Promise<PreparedTx> {
    return this.post(`/v1/${enc(chain)}/${address}/prepare`, { function: fn, args, from: opts.from, value: opts.value }, opts);
  }

  /** decode_tx: "explain what this tx did." */
  decodeTx(chain: ChainInput, txHash: string, opts?: CallOpts): Promise<DecodeTxResult> {
    return this.get(`/v1/${enc(chain)}/tx/${txHash}`, opts);
  }

  /** resolve_name: ENS name → address, or address → primary ENS name. */
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

  private url(path: string, opts?: CallOpts): string {
    const u = this.baseUrl + path;
    return opts?.rpcUrl ? `${u}?rpc_url=${encodeURIComponent(opts.rpcUrl)}` : u;
  }

  private async get<T>(path: string, opts?: CallOpts): Promise<T> {
    return this.request<T>("GET", this.url(path, opts));
  }

  private async post<T>(path: string, body: unknown, opts?: CallOpts): Promise<T> {
    return this.request<T>("POST", this.url(path, opts), body);
  }

  private async request<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
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
    const json = text ? (JSON.parse(text) as unknown) : undefined;

    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })?.error;
      throw new AbiNinjaError(
        (err?.code as ErrorCode) ?? "INTERNAL",
        err?.message ?? `HTTP ${res.status}`,
        res.status,
        err?.details,
      );
    }
    return json as T;
  }
}

/** A resolved-on-demand handle to one contract, viem `getContract` flavour. */
export class Contract {
  private resolved?: Promise<AbiResult>;

  constructor(
    private readonly client: AbiNinja,
    readonly chain: ChainInput,
    readonly address: Address,
  ) {}

  /** Resolve (and memoize) this contract's ABI + manifest. */
  resolve(opts?: CallOpts): Promise<AbiResult> {
    this.resolved ??= this.client.resolveAbi(this.chain, this.address, opts);
    return this.resolved;
  }

  read(fn: string, args: unknown[] = [], opts?: CallOpts): Promise<ReadResult> {
    return this.client.read(this.chain, this.address, fn, args, opts);
  }

  encode(fn: string, args: unknown[] = [], opts?: CallOpts & { value?: string }): Promise<EncodeResult> {
    return this.client.encode(this.chain, this.address, fn, args, opts);
  }

  prepare(fn: string, args: unknown[], opts: CallOpts & { from: Address; value?: string }): Promise<PreparedTx> {
    return this.client.prepareTx(this.chain, this.address, fn, args, opts);
  }
}

/** Chain segment: numbers and alias strings both pass through encodeURIComponent. */
function enc(chain: ChainInput): string {
  return encodeURIComponent(String(chain));
}
