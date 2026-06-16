/**
 * REST surface — SPEC §4. Thin routing over the verbs. `chain` is always a path
 * segment so URLs are cache-key friendly. All responses are BigInt-safe JSON.
 */
import { performance } from "node:perf_hooks";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError } from "./errors.js";
import { config } from "./config.js";
import { safeStringify } from "./util.js";
import { rateLimit } from "./rateLimit.js";
import { metricsSnapshot } from "./metrics.js";
import { getClient } from "./clients.js";
import { listChains } from "./chains.js";
import { compactAbiResult, resolveAbi } from "./resolve/index.js";
import { filterContractInterface, type ContractMethodKind, type ContractMethodSearchOpts } from "./resolve/interface.js";
import { registry } from "./registry/store.js";
import { encodeCall } from "./verbs/encode.js";
import { readContract } from "./verbs/read.js";
import { simulate, requireFrom } from "./verbs/simulate.js";
import { prepareTx } from "./verbs/prepare.js";
import { decodeTx } from "./verbs/decodeTx.js";
import { resolveName } from "./verbs/resolveName.js";
import { openApiSpec } from "./openapi.js";
import { llmsTxt } from "./llms.js";
import { AGENT_VERBS, MCP_UTILITY_TOOLS } from "./agentSurface.js";
import type { AbiResult, CompactAbiResult } from "./types.js";
import type { Address, Hex } from "viem";

/** BigInt-safe JSON response (viem returns bigints throughout). */
function send(c: Context, data: unknown, status: ContentfulStatusCode = 200) {
  return c.body(safeStringify(data), status, { "content-type": "application/json; charset=utf-8" });
}

const rpc = (c: Context) => c.req.query("rpc_url") || undefined;
const cc = (seconds: number, stale = seconds) => `public, max-age=${seconds}, stale-while-revalidate=${stale}`;

export function cacheControlForAbi(result: Pick<AbiResult, "proxy" | "provenance">): string {
  if (result.proxy) return cc(300, 300);
  if (result.provenance.confidence === "verified") return cc(86_400, 604_800);
  if (result.provenance.confidence === "partial") return cc(3_600, 86_400);
  return cc(3_600, 3_600);
}

function queryBool(c: Context, key: string): boolean | undefined {
  const raw = c.req.query(key);
  if (raw == null || raw === "") return undefined;
  if (/^(1|true|yes)$/i.test(raw)) return true;
  if (/^(0|false|no)$/i.test(raw)) return false;
  throw new ApiError("INVALID_ARGS", `${key} must be true or false.`);
}

function queryNonNegativeInt(c: Context, key: string, max: number): number | undefined {
  const raw = c.req.query(key);
  if (raw == null || raw === "") return undefined;
  if (!/^\d+$/.test(raw)) throw new ApiError("INVALID_ARGS", `${key} must be a non-negative integer.`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) {
    throw new ApiError("INVALID_ARGS", `${key} must be a non-negative integer <= ${max}.`);
  }
  return value;
}

function queryMethodKind(c: Context): ContractMethodKind | undefined {
  const raw = c.req.query("method_kind");
  if (raw == null || raw === "") return undefined;
  if (raw === "read" || raw === "write" || raw === "all") return raw;
  throw new ApiError("INVALID_ARGS", "method_kind must be read, write, or all.");
}

function methodFilter(c: Context): ContractMethodSearchOpts | undefined {
  const q = c.req.query("method_q");
  const kind = queryMethodKind(c);
  const limit = queryNonNegativeInt(c, "method_limit", 500);
  if ((q == null || q === "") && kind === undefined && limit === undefined) return undefined;
  return {
    ...(q != null && q !== "" ? { q } : {}),
    ...(kind ? { kind } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function filterAbiInterface<T extends AbiResult | CompactAbiResult>(result: T, filter?: ContractMethodSearchOpts): T {
  if (!filter) return result;
  return { ...result, interface: filterContractInterface(result.interface, filter) };
}

async function jsonBody<T>(c: Context): Promise<T> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new ApiError("INVALID_ARGS", "Request body must be valid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError("INVALID_ARGS", "Request body must be a JSON object.");
  }
  return body as T;
}

function requireFunctionName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError("INVALID_ARGS", "`function` must be a non-empty string.");
  }
  return value;
}

function optionalArgs(value: unknown): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ApiError("INVALID_ARGS", "`args` must be an array.");
  return value;
}

function optionalDecimalValue(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new ApiError("INVALID_ARGS", "`value` must be a decimal string in wei.");
  }
  return value;
}

function requireAddressField(name: string, value: unknown): Address {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new ApiError("INVALID_ARGS", `\`${name}\` must be a 0x address.`);
  }
  return value as Address;
}

function requirePathAddress(value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new ApiError("INVALID_ADDRESS", `Not a valid address: "${value}"`);
  }
  return value as Address;
}

function requireHexData(value: unknown): Hex {
  if (typeof value !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw new ApiError("INVALID_ARGS", "`data` must be 0x-prefixed hex bytes.");
  }
  return value as Hex;
}

export const app = new Hono();

// CORS — the engine is a public, non-credentialed read API consumed by browser
// frontends and arbitrary agents, so allow any origin. Handles the
// preflight OPTIONS automatically (the SDK sends a content-type header on GETs).
app.use(
  "*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400,
  }),
);

// Per-IP rate limit (after CORS so 429s still carry CORS headers).
app.use("*", rateLimit);

app.get("/health", (c) => {
  c.header("Cache-Control", "no-store");
  return send(c, { ok: true, heimdallApi: config.heimdallApiUrl });
});
app.get("/v1/metrics", (c) => {
  c.header("Cache-Control", "no-store");
  return send(c, metricsSnapshot());
});

app.get("/", (c) => {
  c.header("Cache-Control", cc(300, 300));
  return send(c, {
    name: "gulltoppr engine",
    website: "https://gulltoppr.dev",
    spec: "https://github.com/portdeveloper/gulltoppr/blob/main/SPEC.md",
    sdk: "https://www.npmjs.com/package/gulltoppr",
    openapi: "/openapi.json",
    llms: "/llms.txt",
    verbs: AGENT_VERBS,
    mcp_utility_tools: MCP_UTILITY_TOOLS,
    safety_gate: {
      prepare_tx:
        "Only hand off deeplink or wallet_request when safety.signing_recommended is true; risk_level=blocked means do not send.",
    },
    chain_catalog: "/v1/chains",
    metrics: "/v1/metrics",
    integrations: {
      rest_openapi: "https://api.gulltoppr.dev/openapi.json",
      llms: "https://gulltoppr.dev/llms.txt",
      docs: "https://gulltoppr.dev/integrations.md",
      mcp_remote: "https://mcp.gulltoppr.dev/mcp",
      mcp_metadata: [
        "https://mcp.gulltoppr.dev/server.json",
        "https://mcp.gulltoppr.dev/.well-known/mcp-server.json",
      ],
    },
  });
});

app.get("/openapi.json", (c) => {
  c.header("Cache-Control", cc(300, 3_600));
  return send(c, openApiSpec);
});

app.get("/llms.txt", (c) => {
  return c.body(llmsTxt, 200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": cc(300, 3_600),
  });
});

app.get("/v1/chains", (c) => {
  c.header("Cache-Control", cc(3_600, 86_400));
  return send(c, {
    chains: listChains({
      q: c.req.query("q"),
      testnets: queryBool(c, "testnets"),
      hasDefaultRpc: queryBool(c, "has_default_rpc"),
    }),
  });
});

// Registry lookup — the open selector→signature commons. 4-byte (0x + 8 hex,
// functions/errors) or 32-byte (0x + 64 hex, event topic0). Chain-independent.
app.get("/v1/lookup/:selector", async (c) => {
  const selector = c.req.param("selector").toLowerCase();
  if (!/^0x([0-9a-f]{8}|[0-9a-f]{64})$/.test(selector)) {
    throw new ApiError("INVALID_ARGS", "Selector must be 0x + 8 hex chars (function/error) or 0x + 64 hex chars (event topic0).");
  }
  const entries = registry.lookup(selector).map((e) => ({
    kind: e.kind,
    signature: e.signature,
    proof: e.proof, // 'verified-source' (from verified code) | 'keccak-proven' (signature proven; semantics inferred)
    ...(e.abi_item ? { abi_item: e.abi_item } : {}),
    ...(e.chain !== undefined ? { chain: e.chain } : {}),
    ...(e.address ? { address: e.address } : {}),
  }));
  c.header("Cache-Control", cc(300, 3_600));
  return send(c, { selector, entries });
});

app.get("/v1/registry/stats", async (c) => {
  c.header("Cache-Control", cc(60, 300));
  return send(c, registry.stats());
});

// Full dump of the selector commons as JSONL — feeds the CC0 dataset
// (github.com/portdeveloper/evm-abi-commons). Deterministic ordering.
app.get("/v1/registry/export", async (c) => {
  const lines = registry.exportSelectors().map((e) => safeStringify(e)).join("\n");
  return c.body(lines + (lines ? "\n" : ""), 200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": cc(300, 3_600),
    "content-disposition": 'attachment; filename="evm-abi-commons.selectors.ndjson"',
    "link": '<https://creativecommons.org/publicdomain/zero/1.0/>; rel="license"',
    "x-license": "CC0-1.0",
  });
});

// resolve_abi
app.get("/v1/:chain/:address/abi", async (c) => {
  const start = performance.now();
  const includeAbi = queryBool(c, "include_abi") ?? true;
  const filter = methodFilter(c);
  const result = filterAbiInterface(await resolveAbi(c.req.param("chain"), c.req.param("address"), rpc(c)), filter);
  c.header("X-Source", result.provenance.source);
  c.header("X-Confidence", result.provenance.confidence);
  c.header("X-Cache", result.cached ? "HIT" : "MISS");
  c.header("X-Elapsed-Ms", String(Math.max(0, Math.round(performance.now() - start))));
  c.header("X-ABI-Included", includeAbi ? "true" : "false");
  c.header("Cache-Control", cacheControlForAbi(result));
  return send(c, includeAbi ? result : filterAbiInterface(compactAbiResult(result), filter));
});

// read_contract
app.post("/v1/:chain/:address/read", async (c) => {
  const b = await jsonBody<{ function?: unknown; args?: unknown }>(c);
  const address = requirePathAddress(c.req.param("address"));
  const result = await readContract(
    { chain: c.req.param("chain"), address, function: requireFunctionName(b.function), args: optionalArgs(b.args) },
    rpc(c),
  );
  return send(c, result);
});

// encode_call
app.post("/v1/:chain/:address/encode", async (c) => {
  const b = await jsonBody<{ function?: unknown; args?: unknown; value?: unknown }>(c);
  const address = requirePathAddress(c.req.param("address"));
  const result = await encodeCall(
    {
      chain: c.req.param("chain"),
      address,
      function: requireFunctionName(b.function),
      args: optionalArgs(b.args),
      value: optionalDecimalValue(b.value),
    },
    rpc(c),
  );
  return send(c, result);
});

// simulate — raw {from,to,data,value} or high-level {from,address,function,args,value}
app.post("/v1/:chain/simulate", async (c) => {
  const chain = c.req.param("chain");
  const b = await jsonBody<{
    from?: unknown; to?: unknown; data?: unknown; value?: unknown;
    address?: unknown; function?: unknown; args?: unknown;
  }>(c);
  const from = requireFrom(typeof b.from === "string" ? b.from : undefined);
  const value = optionalDecimalValue(b.value);
  const hasRaw = b.to !== undefined || b.data !== undefined;
  const hasHighLevel = b.address !== undefined || b.function !== undefined || b.args !== undefined;

  if (hasRaw && hasHighLevel) {
    throw new ApiError("INVALID_ARGS", "simulate accepts either raw {to,data} or high-level {address,function,args}, not both.");
  }
  if (hasRaw) {
    const to = requireAddressField("to", b.to);
    const data = requireHexData(b.data);
    const { client } = getClient(chain, rpc(c));
    return send(c, await simulate(client, { from, to, data, value }));
  }
  if (hasHighLevel) {
    const address = requireAddressField("address", b.address);
    const fn = requireFunctionName(b.function);
    const enc = await encodeCall({ chain, address, function: fn, args: optionalArgs(b.args) }, rpc(c));
    const { client } = getClient(chain, rpc(c));
    return send(c, await simulate(client, { from, to: address, data: enc.data, value }));
  }
  throw new ApiError("INVALID_ARGS", "simulate needs either {to,data} or {address,function,args}.");
});

// prepare_tx
app.post("/v1/:chain/:address/prepare", async (c) => {
  const b = await jsonBody<{ function?: unknown; args?: unknown; from?: unknown; value?: unknown }>(c);
  const address = requirePathAddress(c.req.param("address"));
  const result = await prepareTx(
    {
      chain: c.req.param("chain"),
      address,
      function: requireFunctionName(b.function),
      args: optionalArgs(b.args),
      from: requireFrom(typeof b.from === "string" ? b.from : undefined),
      value: optionalDecimalValue(b.value),
    },
    rpc(c),
  );
  return send(c, result);
});

// decode_tx
app.get("/v1/:chain/tx/:hash", async (c) => {
  c.header("Cache-Control", "public, max-age=2592000, immutable");
  return send(c, await decodeTx(c.req.param("chain"), c.req.param("hash"), rpc(c)));
});

// resolve_name (reverse must precede the bare-name route)
app.get("/v1/:chain/name/by-address/:address", async (c) => {
  c.header("Cache-Control", cc(60, 300));
  return send(c, await resolveName(c.req.param("chain"), requirePathAddress(c.req.param("address"))));
});
app.get("/v1/:chain/name/:name", async (c) => {
  c.header("Cache-Control", cc(60, 300));
  return send(c, await resolveName(c.req.param("chain"), c.req.param("name")));
});

app.onError((err, c) => {
  if (err instanceof ApiError) return send(c, err.toJSON(), err.status as ContentfulStatusCode);
  console.error("Unhandled error:", err);
  return send(c, { error: { code: "INTERNAL", message: (err as Error).message } }, 500);
});
