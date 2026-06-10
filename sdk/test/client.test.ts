import { describe, it, expect } from "vitest";
import { AbiNinja, AbiNinjaError } from "../src/index.js";

const BASE = "https://engine.test";
const ADDR = "0x0000000000000000000000000000000000000001" as `0x${string}`;

/** A fake fetch that records calls and returns canned JSON; `handler` maps url → {status, body}. */
function fakeFetch(handler: (url: string) => { status?: number; body?: unknown }) {
  const calls: { url: string; method: string; body: any }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const { status = 200, body = {} } = handler(String(url)) ?? {};
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("AbiNinja client", () => {
  it("resolveAbi GETs the abi route and parses the body", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { address: ADDR, abi: [], provenance: { source: "etherscan" } } }));
    const r = await new AbiNinja({ baseUrl: BASE, fetch: fn }).resolveAbi("ethereum", ADDR);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(`${BASE}/v1/ethereum/${ADDR}/abi`);
    expect(r.provenance.source).toBe("etherscan");
  });

  it("appends rpc_url as a query param", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: {} }));
    await new AbiNinja({ baseUrl: BASE, fetch: fn }).resolveAbi("local", ADDR, { rpcUrl: "http://127.0.0.1:8545" });
    expect(calls[0].url).toContain("?rpc_url=http%3A%2F%2F127.0.0.1%3A8545");
  });

  it("read POSTs function + args", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { decoded: ["1"], raw: "0x" } }));
    await new AbiNinja({ baseUrl: BASE, fetch: fn }).read("base", ADDR, "balanceOf", [ADDR]);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${BASE}/v1/base/${ADDR}/read`);
    expect(calls[0].body).toEqual({ function: "balanceOf", args: [ADDR] });
  });

  it("prepareTx POSTs function/args/from/value", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { unsigned_tx: {}, warnings: [] } }));
    await new AbiNinja({ baseUrl: BASE, fetch: fn }).prepareTx("base", ADDR, "transfer", [ADDR, "1"], { from: ADDR, value: "0" });
    expect(calls[0].url).toBe(`${BASE}/v1/base/${ADDR}/prepare`);
    expect(calls[0].body).toEqual({ function: "transfer", args: [ADDR, "1"], from: ADDR, value: "0" });
  });

  it("decodeTx GETs the tx route", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { source: "heimdall-decoded" } }));
    await new AbiNinja({ baseUrl: BASE, fetch: fn }).decodeTx("ethereum", "0xdead");
    expect(calls[0].url).toBe(`${BASE}/v1/ethereum/tx/0xdead`);
  });

  it("resolveName routes name vs address to the right endpoint", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: {} }));
    const n = new AbiNinja({ baseUrl: BASE, fetch: fn });
    await n.resolveName("vitalik.eth");
    await n.resolveName(ADDR);
    expect(calls[0].url).toBe(`${BASE}/v1/ethereum/name/vitalik.eth`);
    expect(calls[1].url).toBe(`${BASE}/v1/ethereum/name/by-address/${ADDR}`);
  });

  it("throws AbiNinjaError carrying the engine's code + status", async () => {
    const { fn } = fakeFetch(() => ({ status: 404, body: { error: { code: "FUNCTION_NOT_FOUND", message: "no fn" } } }));
    const n = new AbiNinja({ baseUrl: BASE, fetch: fn });
    await expect(n.read("base", ADDR, "nope", [])).rejects.toMatchObject({
      name: "AbiNinjaError",
      code: "FUNCTION_NOT_FOUND",
      status: 404,
    });
  });

  it("maps transport failures to a NETWORK error", async () => {
    const fn = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await expect(new AbiNinja({ baseUrl: BASE, fetch: fn }).resolveAbi("base", ADDR)).rejects.toBeInstanceOf(AbiNinjaError);
  });

  it("contract() memoizes resolve (one network call for two resolves)", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { address: ADDR, abi: [], provenance: {} } }));
    const c = new AbiNinja({ baseUrl: BASE, fetch: fn }).contract("base", ADDR);
    await c.resolve();
    await c.resolve();
    expect(calls.filter((x) => x.url.endsWith("/abi")).length).toBe(1);
  });

  it("defaults baseUrl to the live engine", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: {} }));
    await new AbiNinja({ fetch: fn }).resolveName("vitalik.eth");
    expect(calls[0].url.startsWith("https://gulltoppr.fly.dev/")).toBe(true);
  });
});
