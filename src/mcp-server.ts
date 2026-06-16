/**
 * Shared MCP server factory — SPEC §5. Agent verbs plus read-only utility tools.
 * The tools are a thin adapter over the deployed REST engine, so the MCP
 * server shares the engine's persistent cache and Etherscan key (no in-process
 * resolution, no duplicated secrets). Both transports import this:
 *  - mcp.ts        → stdio   (Claude Desktop / Code / local clients)
 *  - mcp-http.ts   → Streamable HTTP (remote agents, no local install)
 *
 * Baked in per SPEC §5: prepare_tx's description states the non-custodial hand-off
 * explicitly; decompiled/selector-only results LEAD with the provenance warning.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Address, Hex } from "viem";

import { safeStringify } from "./util.js";
import { config } from "./config.js";
import type { CompactAbiResult, PreparedTx } from "./types.js";

export const MCP_SERVER_VERSION = "0.2.2";

class McpEngineError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = "McpEngineError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

// ── result helpers ──────────────────────────────────────────────────────────
function ok(data: unknown, lead?: string): CallToolResult {
  const text = lead ? `${lead}\n\n${safeStringify(data, 2)}` : safeStringify(data, 2);
  return { content: [{ type: "text", text }] };
}

function okStructured(data: Record<string, unknown>, lead?: string): CallToolResult {
  return { ...ok(data, lead), structuredContent: data };
}

function prepareLead(r: PreparedTx): string | undefined {
  const safety = r.safety;
  const shouldLead =
    r.warnings.length > 0 ||
    safety.risk_level !== "low" ||
    safety.requires_human_confirmation ||
    !safety.signing_recommended;
  if (!shouldLead) return undefined;

  const reasons = safety.reasons.length ? ` reasons=${safety.reasons.join(",")}.` : "";
  const warnings = r.warnings.length ? ` ${r.warnings.join(" ")}` : "";
  return `WARNING risk=${safety.risk_level}; signing_recommended=${safety.signing_recommended}; requires_human_confirmation=${safety.requires_human_confirmation}.${reasons}${warnings}`;
}

function resolveLead(r: CompactAbiResult): string | undefined {
  const warnings: string[] = [];
  const p = r.provenance;
  if (p.names_synthetic || p.confidence === "decompiled" || p.confidence === "selector-only") {
    warnings.push(`${p.confidence} ABI: names or mutability may be inferred; confirm selector and intent before writes`);
  }
  if (p.confidence === "partial") {
    warnings.push("partial provenance: not full verified-source ground truth for this exact address");
  }
  if (p.bytecode_match) {
    warnings.push(
      `bytecode match: ABI reused from ${p.bytecode_match.address} on chain ${p.bytecode_match.chain} (${p.bytecode_match.source}/${p.bytecode_match.confidence})`,
    );
  }
  if (r.proxy) {
    const target = r.proxy.pattern === "diamond"
      ? `${r.proxy.hops.filter((hop) => hop.role === "facet").length} facet(s)`
      : r.proxy.resolved_implementation ?? r.abi_for;
    warnings.push(`${r.proxy.pattern} proxy: ABI resolves against ${target}`);
  }
  if (!warnings.length) return undefined;
  return `WARNING ${warnings.join("; ")}.`;
}

function fail(e: unknown): CallToolResult {
  const body =
    e instanceof McpEngineError
      ? { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } }
      : { error: { code: "INTERNAL", message: (e as Error).message } };
  return { content: [{ type: "text", text: safeStringify(body, 2) }], isError: true };
}
/** Wrap a handler so engine errors become MCP isError results, never crashes. */
function guard<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}

// ── shared zod fields ────────────────────────────────────────────────────────
const chain = z.union([z.string().min(1), z.number().int().positive()]).describe('Chain alias from GET /v1/chains (for example "ethereum", "base", "monad", "bsc") or numeric EIP-155 chain id.');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).describe("0x contract address.");
const fn = z.string().min(1).regex(/\S/).describe('Function name, or full signature like "transfer(address,uint256)" if overloaded.');
const args = z.array(z.any()).default([]).describe("Function arguments, in order. Pass uint values as decimal strings.");
const value = z.string().regex(/^\d+$/).optional().describe("Native value in wei (decimal string), for payable functions.");
const rpc_url = z.string().regex(/^https?:\/\/\S+$/).optional().describe("Override HTTP(S) RPC URL. Required for chains with no default (e.g. local/31337) or custom EVM chain ids.");
const method_q = z.string().optional().describe("Case-insensitive manifest method search across names, signatures, parameters, outputs, and hints.");
const method_kind = z.enum(["read", "write", "all"]).optional().describe("Restrict manifest methods to read, write, or all.");
const method_limit = z.number().int().min(0).max(500).optional().describe("Maximum number of manifest methods to return after filtering.");
const from = address.describe("The sender address (the user's wallet). No key is needed — nothing is signed.");
const calldata = z.string().regex(/^0x([0-9a-fA-F]{2})*$/).describe("Raw form: calldata (0x-prefixed hex bytes).");
const txHash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("0x transaction hash.");
const selector = z.string().regex(/^0x([0-9a-fA-F]{8}|[0-9a-fA-F]{64})$/).describe("4-byte function/error selector or 32-byte event topic0.");

const READ = { readOnlyHint: true, openWorldHint: true } as const;

const ioParamSchema = z.object({
  name: z.string(),
  type: z.string(),
}).passthrough();

const jsonValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.any()),
  z.record(z.string(), z.any()),
  z.null(),
]);

const provenanceSourceSchema = z.enum(["etherscan", "sourcify", "proxy-impl", "bytecode-match", "heimdall-decompiled", "4byte"]);
const provenanceConfidenceSchema = z.enum(["verified", "partial", "decompiled", "selector-only"]);
const provenanceSchema = z.object({
  source: provenanceSourceSchema,
  confidence: provenanceConfidenceSchema,
  verified: z.boolean(),
  names_synthetic: z.boolean(),
  natspec: z.boolean(),
  bytecode_match: z.object({
    chain: z.number().int(),
    address,
    source: provenanceSourceSchema,
    confidence: provenanceConfidenceSchema,
  }).passthrough().optional(),
  notes: z.string().optional(),
}).passthrough();

const resolveAbiOutputSchema = {
  chain: z.number().int(),
  address,
  interface: z.object({
    reads: z.array(z.object({
      function: z.string(),
      signature: z.string(),
      inputs: z.array(ioParamSchema),
      outputs: z.array(ioParamSchema),
      names_synthetic: z.boolean(),
      hint: z.string().optional(),
    }).passthrough()),
    writes: z.array(z.object({
      function: z.string(),
      signature: z.string(),
      inputs: z.array(ioParamSchema),
      payable: z.boolean(),
      names_synthetic: z.boolean(),
      hint: z.string().optional(),
    }).passthrough()),
  }).passthrough(),
  provenance: provenanceSchema,
  proxy: z.object({
    is_proxy: z.literal(true),
    pattern: z.enum(["eip1967", "uups", "transparent", "beacon", "diamond", "minimal-1167", "unknown"]),
    hops: z.array(z.object({
      address,
      role: z.enum(["proxy", "implementation", "beacon", "facet"]),
    }).passthrough()),
    resolved_implementation: address.optional(),
  }).passthrough().optional(),
  token: z.object({
    kind: z.enum(["erc20", "erc721", "erc1155"]).nullable(),
    symbol: z.string().optional(),
    decimals: z.number().int().optional(),
    name: z.string().optional(),
  }).passthrough().optional(),
  abi_for: address,
  cached: z.boolean(),
  abi_omitted: z.literal(true),
} as const;

const readContractOutputSchema = {
  decoded: z.array(z.any()),
  raw: calldata,
  function_signature: z.string(),
} as const;

const encodeCallOutputSchema = {
  data: calldata,
  function_signature: z.string(),
} as const;

const simulationOutputSchema = {
  success: z.boolean(),
  gas_used: z.number().int().nonnegative(),
  return_value: z.object({
    decoded: z.array(z.any()),
    raw: calldata,
  }).passthrough().optional(),
  state_diff: z.array(z.object({
    address,
    slot_label: z.string().optional(),
    before: z.string(),
    after: z.string(),
  }).passthrough()),
  asset_changes: z.array(z.object({
    address,
    token: address,
    symbol: z.string().optional(),
    delta: z.string().regex(/^-?\d+$/),
    kind: z.enum(["erc20", "erc721", "erc1155", "native"]),
  }).passthrough()),
  logs: z.array(z.object({
    address,
    event: z.string().optional(),
    args: z.record(z.string(), z.any()).optional(),
  }).passthrough()),
  revert: z.object({
    reason: z.string(),
    decoded: z.string().optional(),
  }).passthrough().optional(),
} as const;

const preparedTxOutputSchema = {
  unsigned_tx: z.object({
    chainId: z.number().int(),
    to: address,
    from,
    data: calldata,
    value: z.string().regex(/^\d+$/),
    gas: z.string().regex(/^\d+$/).optional(),
  }).passthrough(),
  simulation: z.object({
    success: z.boolean(),
    gas_used: z.number().int().nonnegative(),
    state_diff: z.array(z.any()),
    asset_changes: z.array(z.any()),
    logs: z.array(z.any()),
    return_value: z.any().optional(),
    revert: z.any().optional(),
  }).passthrough(),
  human_summary: z.string(),
  deeplink: z.string(),
  wallet_request: z.any().optional(),
  warnings: z.array(z.string()),
  safety: z.object({
    signing_recommended: z.boolean(),
    risk_level: z.enum(["low", "medium", "high", "blocked"]),
    requires_human_confirmation: z.boolean(),
    reasons: z.array(z.enum(["abi_names_inferred", "proxy", "simulation_failed", "native_value", "spending_approval", "asset_outflow"])),
  }).passthrough(),
} as const;

const decodeTxProvenanceSchema = z.object({
  source: z.string(),
  confidence: z.literal("decompiled"),
  verified: z.literal(false),
  names_synthetic: z.literal(true),
}).passthrough();

const decodedCallArgSchema = z.object({
  name: z.string(),
  type: z.string(),
  value: jsonValueSchema,
}).passthrough();

const decodedCallSchema = z.object({
  to: address,
  function: z.string(),
  signature: z.string(),
  args: z.array(decodedCallArgSchema),
  abi_for: address,
  provenance: provenanceSchema,
}).passthrough();

const decodeTxOutputSchema = {
  chain: z.number().int(),
  tx_hash: txHash,
  source: z.string(),
  cached: z.boolean(),
  decoded: jsonValueSchema,
  provenance: decodeTxProvenanceSchema,
  decoded_call: decodedCallSchema.nullable().optional(),
} as const;

const resolveNameOutputSchema = {
  address: address.optional(),
  name: z.string().optional(),
} as const;

const chainInfoSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  aliases: z.array(z.string()),
  testnet: z.boolean(),
  has_default_rpc: z.boolean(),
  default_rpc_url: rpc_url.optional(),
  native_currency: z.object({
    name: z.string(),
    symbol: z.string(),
    decimals: z.number().int().nonnegative(),
  }).passthrough(),
  block_explorer_url: z.string().url().optional(),
}).passthrough();

const listChainsOutputSchema = {
  chains: z.array(chainInfoSchema),
} as const;

const metricBucketSchema = z.object({
  attempts: z.number().int().nonnegative(),
  successes: z.number().int().nonnegative(),
  misses: z.number().int().nonnegative(),
  failures: z.number().int().nonnegative(),
  total_latency_ms: z.number().int().nonnegative(),
  avg_latency_ms: z.number().int().nonnegative(),
  max_latency_ms: z.number().int().nonnegative(),
  failure_rate: z.number().min(0).max(1),
  last_error: z.string().optional(),
}).passthrough();

const runtimeMetricsOutputSchema = {
  uptime_seconds: z.number().int().nonnegative(),
  metrics: z.record(z.string(), metricBucketSchema),
} as const;

const selectorEntrySchema = z.object({
  kind: z.enum(["function", "event", "error"]),
  signature: z.string(),
  proof: z.enum(["verified-source", "keccak-proven"]),
  abi_item: jsonValueSchema.optional(),
  chain: z.number().int().positive().optional(),
  address: address.optional(),
}).passthrough();

const lookupSelectorOutputSchema = {
  selector,
  entries: z.array(selectorEntrySchema),
} as const;

const registryStatsOutputSchema = {
  selectors: z.record(z.string(), z.number().int().nonnegative()),
  bytecodes: z.number().int().nonnegative(),
} as const;

type SimulateToolArgs = {
  from: string;
  address?: string;
  function?: string;
  args?: unknown[];
  to?: string;
  data?: string;
  value?: string;
};

function invalidArgs(message: string): never {
  throw new McpEngineError("INVALID_ARGS", message, 0);
}

type ChainArg = string | number;

function enc(input: ChainArg): string {
  return encodeURIComponent(String(input));
}

function requireAddress(name: string, input: unknown): Address {
  if (typeof input !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(input)) {
    invalidArgs(`\`${name}\` must be a 0x address.`);
  }
  return input as Address;
}

function requireFunctionName(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    invalidArgs("`function` must be a non-empty string.");
  }
  return input;
}

function requireArgs(input: unknown): unknown[] {
  if (!Array.isArray(input)) invalidArgs("`args` must be an array.");
  return input;
}

function optionalDecimalValue(input: unknown): string | undefined {
  if (input === undefined) return undefined;
  if (typeof input !== "string" || !/^\d+$/.test(input)) {
    invalidArgs("`value` must be a decimal string in wei.");
  }
  return input;
}

function requireHexData(input: unknown): Hex {
  if (typeof input !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(input)) {
    invalidArgs("`data` must be 0x-prefixed hex bytes.");
  }
  return input as Hex;
}

function requireTxHash(input: unknown): string {
  if (typeof input !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(input)) {
    invalidArgs("`tx_hash` must be 0x + 64 hex chars.");
  }
  return input;
}

function requireSelector(input: unknown): string {
  if (typeof input !== "string" || !/^0x([0-9a-fA-F]{8}|[0-9a-fA-F]{64})$/.test(input)) {
    invalidArgs("`selector` must be 0x + 8 hex chars or 0x + 64 hex chars.");
  }
  return input.toLowerCase();
}

function requireName(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    invalidArgs("`name` must be a non-empty string.");
  }
  return input;
}

function simulateArgs(input: SimulateToolArgs): Record<string, unknown> {
  const from = requireAddress("from", input.from);
  const value = optionalDecimalValue(input.value);
  const hasRaw = input.to !== undefined || input.data !== undefined;
  const hasHighLevel = input.address !== undefined || input.function !== undefined || input.args !== undefined;
  if (hasRaw && hasHighLevel) {
    invalidArgs("simulate accepts either raw {to,data} or high-level {address,function,args}, not both.");
  }
  if (hasRaw) {
    if (!input.to || !input.data) {
      invalidArgs("simulate raw form requires both `to` and `data`.");
    }
    return {
      from,
      to: requireAddress("to", input.to),
      data: requireHexData(input.data),
      ...(value ? { value } : {}),
    };
  }
  if (hasHighLevel) {
    if (!input.address || !input.function) {
      invalidArgs("simulate high-level form requires both `address` and `function`.");
    }
    return {
      from,
      address: requireAddress("address", input.address),
      function: requireFunctionName(input.function),
      args: input.args === undefined ? [] : requireArgs(input.args),
      ...(value ? { value } : {}),
    };
  }
  invalidArgs("simulate needs either {to,data} or {address,function,args}.");
}

async function engineText(
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; rpcUrl?: string; includeAbi?: boolean; methodQ?: string; methodKind?: "read" | "write" | "all"; methodLimit?: number } = {},
): Promise<string> {
  const url = new URL(path, config.engineUrl);
  if (opts.includeAbi !== undefined) url.searchParams.set("include_abi", String(opts.includeAbi));
  if (opts.methodQ) url.searchParams.set("method_q", opts.methodQ);
  if (opts.methodKind) url.searchParams.set("method_kind", opts.methodKind);
  if (opts.methodLimit !== undefined) url.searchParams.set("method_limit", String(opts.methodLimit));
  if (opts.rpcUrl) url.searchParams.set("rpc_url", opts.rpcUrl);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
  } catch (e) {
    throw new McpEngineError("NETWORK", `Failed to reach gulltoppr engine: ${(e as Error).message}`, 0);
  }

  const text = await res.text();
  if (!res.ok) {
    let body: unknown;
    try {
      body = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      body = undefined;
    }
    const err = (body as { error?: { code?: string; message?: string; details?: Record<string, unknown> } })?.error;
    throw new McpEngineError(
      err?.code ?? "INTERNAL",
      err?.message ?? `HTTP ${res.status}`,
      res.status,
      err?.details,
    );
  }
  return text;
}

async function engineJson<T>(
  method: "GET" | "POST",
  path: string,
  opts: { body?: unknown; rpcUrl?: string; includeAbi?: boolean; methodQ?: string; methodKind?: "read" | "write" | "all"; methodLimit?: number } = {},
): Promise<T> {
  const text = await engineText(method, path, opts);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new McpEngineError(
      "INTERNAL",
      "gulltoppr engine returned invalid JSON",
      200,
    );
  }
  if (!body || typeof body !== "object") {
    throw new McpEngineError("INTERNAL", "gulltoppr engine returned invalid JSON object", 200);
  }
  return body as T;
}

function chainQuery(opts: { q?: string; testnets?: boolean; has_default_rpc?: boolean }): string {
  const params = new URLSearchParams();
  if (opts.q) params.set("q", opts.q);
  if (opts.testnets !== undefined) params.set("testnets", String(opts.testnets));
  if (opts.has_default_rpc !== undefined) params.set("has_default_rpc", String(opts.has_default_rpc));
  const qs = params.toString();
  return `/v1/chains${qs ? `?${qs}` : ""}`;
}

async function resolveCompactAbi(
  chain: ChainArg,
  address: string,
  opts: { rpcUrl?: string; methodQ?: string; methodKind?: "read" | "write" | "all"; methodLimit?: number } = {},
): Promise<CompactAbiResult> {
  return engineJson("GET", `/v1/${enc(chain)}/${requireAddress("address", address)}/abi`, {
    includeAbi: false,
    rpcUrl: opts.rpcUrl,
    methodQ: opts.methodQ,
    methodKind: opts.methodKind,
    methodLimit: opts.methodLimit,
  });
}

async function readContract(chain: ChainArg, address: string, fn: string, args: unknown[], rpcUrl?: string): Promise<unknown> {
  return engineJson("POST", `/v1/${enc(chain)}/${requireAddress("address", address)}/read`, {
    body: { function: requireFunctionName(fn), args: requireArgs(args) },
    rpcUrl,
  });
}

async function encodeCall(
  chain: ChainArg,
  address: string,
  fn: string,
  args: unknown[],
  value: string | undefined,
  rpcUrl?: string,
): Promise<unknown> {
  return engineJson("POST", `/v1/${enc(chain)}/${requireAddress("address", address)}/encode`, {
    body: { function: requireFunctionName(fn), args: requireArgs(args), value: optionalDecimalValue(value) },
    rpcUrl,
  });
}

async function simulate(chain: ChainArg, args: SimulateToolArgs, rpcUrl?: string): Promise<unknown> {
  return engineJson("POST", `/v1/${enc(chain)}/simulate`, {
    body: simulateArgs(args),
    rpcUrl,
  });
}

async function prepareTx(
  chain: ChainArg,
  address: string,
  fn: string,
  args: unknown[],
  from: string,
  value: string | undefined,
  rpcUrl?: string,
): Promise<PreparedTx> {
  return engineJson("POST", `/v1/${enc(chain)}/${requireAddress("address", address)}/prepare`, {
    body: {
      function: requireFunctionName(fn),
      args: requireArgs(args),
      from: requireAddress("from", from),
      value: optionalDecimalValue(value),
    },
    rpcUrl,
  });
}

async function decodeTx(chain: ChainArg, txHash: string, rpcUrl?: string): Promise<unknown> {
  return engineJson("GET", `/v1/${enc(chain)}/tx/${requireTxHash(txHash)}`, { rpcUrl });
}

async function resolveName(name: string, chain: ChainArg = "ethereum"): Promise<unknown> {
  const target = requireName(name);
  const path = /^0x[0-9a-fA-F]{40}$/.test(target)
    ? `/v1/${enc(chain)}/name/by-address/${target}`
    : `/v1/${enc(chain)}/name/${encodeURIComponent(target)}`;
  return engineJson("GET", path);
}

/** Build a fully-configured MCP server (agent verbs plus read-only utility tools). */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "gulltoppr", version: MCP_SERVER_VERSION });

  server.registerTool(
    "list_chains",
    {
      title: "List supported chains",
      description: "List viem-backed chain aliases and ids. Use filters to find testnets, default-RPC chains, or a named chain before resolving contracts.",
      inputSchema: {
        q: z.string().optional().describe("Search by chain id, name, alias, or native symbol; multi-word queries also match token-by-token and without whitespace."),
        testnets: z.boolean().optional().describe("When true, only testnets; when false, only mainnets."),
        has_default_rpc: z.boolean().optional().describe("When true, only chains gulltoppr can query without rpc_url."),
      },
      outputSchema: listChainsOutputSchema,
      annotations: READ,
    },
    guard(async ({ q, testnets, has_default_rpc }) =>
      okStructured(await engineJson("GET", chainQuery({ q, testnets, has_default_rpc })) as Record<string, unknown>),
    ),
  );

  server.registerTool(
    "runtime_metrics",
    {
      title: "Runtime metrics",
      description: "Read process-local resolver/rung/RPC counters for smoke checks and reliability dashboards.",
      inputSchema: {},
      outputSchema: runtimeMetricsOutputSchema,
      annotations: READ,
    },
    guard(async () => okStructured(await engineJson("GET", "/v1/metrics") as Record<string, unknown>)),
  );

  server.registerTool(
    "lookup_selector",
    {
      title: "Lookup selector commons",
      description: "Lookup gulltoppr-proven signatures for a 4-byte function/error selector or 32-byte event topic0. Prefer these over public 4byte guesses.",
      inputSchema: { selector },
      outputSchema: lookupSelectorOutputSchema,
      annotations: READ,
    },
    guard(async ({ selector }) => okStructured(await engineJson("GET", `/v1/lookup/${requireSelector(selector)}`) as Record<string, unknown>)),
  );

  server.registerTool(
    "registry_stats",
    {
      title: "Registry stats",
      description: "Read selector commons counts by proof grade and bytecode-match index size.",
      inputSchema: {},
      outputSchema: registryStatsOutputSchema,
      annotations: READ,
    },
    guard(async () => okStructured(await engineJson("GET", "/v1/registry/stats") as Record<string, unknown>)),
  );

  server.registerTool(
    "export_registry",
    {
      title: "Export selector commons",
      description: "Return the CC0 selector commons as NDJSON. This can be large; prefer lookup_selector for normal agent workflows.",
      inputSchema: {},
      annotations: READ,
    },
    guard(async () => ({
      content: [{ type: "text", text: await engineText("GET", "/v1/registry/export") }],
    })),
  );

  server.registerTool(
    "resolve_abi",
    {
      title: "Resolve contract ABI",
      description:
        "Resolve a contract's interface from chain + address via a fallback ladder " +
        "(Etherscan → Sourcify → proxy → heimdall decompile → 4byte). Returns a compact capability " +
        "manifest (read vs write functions, the 'buttons'), proxy chain, token metadata, and " +
        "PROVENANCE. ALWAYS read `provenance`: a `decompiled` ABI has synthetic function names — " +
        "treat it with care and confirm intent before writing. Partial, proxy, and bytecode-match results lead with a WARNING before the JSON. The compact manifest/provenance is also returned as structuredContent. Use method_q/method_kind/method_limit for large ABIs. Raw ABI is omitted from MCP output to save tokens; use REST/SDK resolve_abi with include_abi=true if needed.",
      inputSchema: { chain, address, method_q, method_kind, method_limit, rpc_url },
      outputSchema: resolveAbiOutputSchema,
      annotations: READ,
    },
    guard(async ({ chain, address, method_q, method_kind, method_limit, rpc_url }) => {
      const r = await resolveCompactAbi(chain, address, {
        rpcUrl: rpc_url,
        methodQ: method_q,
        methodKind: method_kind,
        methodLimit: method_limit,
      });
      return okStructured(r as unknown as Record<string, unknown>, resolveLead(r));
    }),
  );

  server.registerTool(
    "read_contract",
    {
      title: "Read a contract (view/pure)",
      description: "Call a view/pure function and get the decoded result. No wallet, no cost. Rejects state-mutating functions.",
      inputSchema: { chain, address, function: fn, args, rpc_url },
      outputSchema: readContractOutputSchema,
      annotations: READ,
    },
    guard(async ({ chain, address, function: f, args, rpc_url }) =>
      okStructured(await readContract(chain, address, f, args, rpc_url) as Record<string, unknown>),
    ),
  );

  server.registerTool(
    "encode_call",
    {
      title: "Encode a function call",
      description: "Encode a function call to calldata (0x…) without sending anything.",
      inputSchema: { chain, address, function: fn, args, value, rpc_url },
      outputSchema: encodeCallOutputSchema,
      annotations: READ,
    },
    guard(async ({ chain, address, function: f, args, value, rpc_url }) =>
      okStructured(await encodeCall(chain, address, f, args, value, rpc_url) as Record<string, unknown>),
    ),
  );

  server.registerTool(
    "simulate",
    {
      title: "Simulate a transaction",
      description:
        "Simulate a call and return success, gas, decoded return, and best-effort state diff / " +
        "asset changes / logs. Provide a high-level call (address + function + args) or raw (to + data), never both.",
      inputSchema: {
        chain, from,
        address: address.optional(), function: fn.optional(), args: args.optional(),
        to: address.optional().describe("Raw form: target address."),
        data: calldata.optional(),
        value, rpc_url,
      },
      outputSchema: simulationOutputSchema,
      annotations: READ,
    },
    guard(async ({ chain, from, address, function: f, args, to, data, value, rpc_url }) => {
      return okStructured(await simulate(chain, {
        from,
        address,
        function: f,
        args,
        to,
        data,
        value,
      }, rpc_url) as Record<string, unknown>);
    }),
  );

  server.registerTool(
    "prepare_tx",
    {
      title: "Prepare an unsigned transaction (hand-off)",
      description:
        "Prepare a contract WRITE for the user to sign. Returns an UNSIGNED transaction, its " +
        "simulation, a human-readable summary, safety metadata, warnings, a configured signing deeplink, and an EIP-1193 wallet request when signing is recommended. " +
        "IMPORTANT: this tool NEVER signs or broadcasts. Present the summary + simulation + " +
        "warnings to the user. Only hand them the `deeplink` or `wallet_request` when `safety.signing_recommended` is true. " +
        "If `safety.risk_level` is high or blocked, make that explicit; blocked means do not send.",
      inputSchema: { chain, address, function: fn, args, from, value, rpc_url },
      outputSchema: preparedTxOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async ({ chain, address, function: f, args, from, value, rpc_url }) => {
      const r = await prepareTx(chain, address, f, args, from, value, rpc_url);
      return okStructured(r as unknown as Record<string, unknown>, prepareLead(r));
    }),
  );

  server.registerTool(
    "decode_tx",
    {
      title: "Explain a transaction",
      description:
        "Decode what a transaction did: delegated heimdall decode plus `decoded_call` from the resolved target ABI when available. Prefer `decoded_call` for typed function/arg names, and read its provenance.",
      inputSchema: { chain, tx_hash: txHash, rpc_url },
      outputSchema: decodeTxOutputSchema,
      annotations: READ,
    },
    guard(async ({ chain, tx_hash, rpc_url }) => okStructured(await decodeTx(chain, tx_hash, rpc_url) as Record<string, unknown>)),
  );

  server.registerTool(
    "resolve_name",
    {
      title: "Resolve ENS/Basenames ⇄ address",
      description: "Resolve an ENS/Basename to an address, or an address to its primary ENS/Basename. Pass chain=base for Basenames.",
      inputSchema: { name: z.string().min(1).regex(/\S/).describe("An ENS/Basename (vitalik.eth, name.base.eth) or a 0x address."), chain: chain.optional() },
      outputSchema: resolveNameOutputSchema,
      annotations: READ,
    },
    guard(async ({ name, chain }) => okStructured(await resolveName(name, chain) as Record<string, unknown>)),
  );

  return server;
}
