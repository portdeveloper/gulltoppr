/**
 * REST surface — SPEC §4. Thin routing over the verbs. `chain` is always a path
 * segment so URLs are cache-key friendly. All responses are BigInt-safe JSON.
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ApiError } from "./errors.js";
import { config } from "./config.js";
import { safeStringify } from "./util.js";
import { rateLimit } from "./rateLimit.js";
import { getClient } from "./clients.js";
import { resolveAbi } from "./resolve/index.js";
import { encodeCall } from "./verbs/encode.js";
import { readContract } from "./verbs/read.js";
import { simulate, requireFrom } from "./verbs/simulate.js";
import { prepareTx } from "./verbs/prepare.js";
import { decodeTx } from "./verbs/decodeTx.js";
import { resolveName } from "./verbs/resolveName.js";
import type { Address, Hex } from "viem";

/** BigInt-safe JSON response (viem returns bigints throughout). */
function send(c: Context, data: unknown, status: ContentfulStatusCode = 200) {
  return c.body(safeStringify(data), status, { "content-type": "application/json; charset=utf-8" });
}

const rpc = (c: Context) => c.req.query("rpc_url") || undefined;

export const app = new Hono();

// CORS — the engine is a public, non-credentialed read API consumed by browser
// frontends (abi.ninja) and arbitrary agents, so allow any origin. Handles the
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

app.get("/health", (c) => send(c, { ok: true, heimdallApi: config.heimdallApiUrl }));

app.get("/", (c) =>
  send(c, {
    name: "abi.ninja engine",
    spec: "../SPEC.md",
    verbs: ["resolve_abi", "read_contract", "encode_call", "simulate", "prepare_tx", "decode_tx", "resolve_name"],
  }),
);

// resolve_abi
app.get("/v1/:chain/:address/abi", async (c) => {
  const result = await resolveAbi(c.req.param("chain"), c.req.param("address"), rpc(c));
  c.header("X-Source", result.provenance.source);
  c.header("X-Confidence", result.provenance.confidence);
  c.header("X-Cache", result.cached ? "HIT" : "MISS");
  return send(c, result);
});

// read_contract
app.post("/v1/:chain/:address/read", async (c) => {
  const b = await c.req.json<{ function: string; args?: unknown[] }>();
  const result = await readContract(
    { chain: c.req.param("chain"), address: c.req.param("address") as Address, function: b.function, args: b.args ?? [] },
    rpc(c),
  );
  return send(c, result);
});

// encode_call
app.post("/v1/:chain/:address/encode", async (c) => {
  const b = await c.req.json<{ function: string; args?: unknown[]; value?: string }>();
  const result = await encodeCall(
    { chain: c.req.param("chain"), address: c.req.param("address") as Address, function: b.function, args: b.args ?? [], value: b.value },
    rpc(c),
  );
  return send(c, result);
});

// simulate — raw {from,to,data,value} or high-level {from,address,function,args,value}
app.post("/v1/:chain/simulate", async (c) => {
  const chain = c.req.param("chain");
  const b = await c.req.json<{
    from: string; to?: Address; data?: Hex; value?: string;
    address?: Address; function?: string; args?: unknown[];
  }>();
  const from = requireFrom(b.from);
  const { client } = getClient(chain, rpc(c));

  if (b.data && b.to) {
    return send(c, await simulate(client, { from, to: b.to, data: b.data, value: b.value }));
  }
  if (b.address && b.function) {
    const enc = await encodeCall({ chain, address: b.address, function: b.function, args: b.args ?? [] }, rpc(c));
    return send(c, await simulate(client, { from, to: b.address, data: enc.data, value: b.value }));
  }
  throw new ApiError("INVALID_ARGS", "simulate needs either {to,data} or {address,function,args}.");
});

// prepare_tx
app.post("/v1/:chain/:address/prepare", async (c) => {
  const b = await c.req.json<{ function: string; args?: unknown[]; from: Address; value?: string }>();
  const result = await prepareTx(
    { chain: c.req.param("chain"), address: c.req.param("address") as Address, function: b.function, args: b.args ?? [], from: b.from, value: b.value },
    rpc(c),
  );
  return send(c, result);
});

// decode_tx
app.get("/v1/:chain/tx/:hash", async (c) => {
  return send(c, await decodeTx(c.req.param("chain"), c.req.param("hash"), rpc(c)));
});

// resolve_name (reverse must precede the bare-name route)
app.get("/v1/:chain/name/by-address/:address", async (c) => send(c, await resolveName(c.req.param("address"))));
app.get("/v1/:chain/name/:name", async (c) => send(c, await resolveName(c.req.param("name"))));

app.onError((err, c) => {
  if (err instanceof ApiError) return send(c, err.toJSON(), err.status as ContentfulStatusCode);
  console.error("Unhandled error:", err);
  return send(c, { error: { code: "INTERNAL", message: (err as Error).message } }, 500);
});
