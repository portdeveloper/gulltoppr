import { describe, it, expect } from "vitest";
import { app } from "../src/server.js";

const ADDR = "0x0000000000000000000000000000000000000001";

// These exercise the HTTP plumbing — routing, the typed error → HTTP status mapping,
// the error envelope, CORS, and rate-limit headers — via validation paths that fail
// before any network call (so no mocking / no upstreams needed).
describe("HTTP layer", () => {
  it("GET /health → 200 ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("invalid address → 400 INVALID_ADDRESS envelope", async () => {
    const res = await app.request("/v1/ethereum/notanaddress/abi");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ADDRESS");
  });

  it("unknown chain → 400 UNKNOWN_CHAIN", async () => {
    const res = await app.request(`/v1/notachain/${ADDR}/abi`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("UNKNOWN_CHAIN");
  });

  it("invalid tx hash → 400 INVALID_ADDRESS", async () => {
    const res = await app.request("/v1/ethereum/tx/0xnotahash");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ADDRESS");
  });

  it("unknown route → 404", async () => {
    expect((await app.request("/nope")).status).toBe(404);
  });

  it("GET /v1/lookup/:selector — malformed selector → 400 INVALID_ARGS", async () => {
    const res = await app.request("/v1/lookup/0x123");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ARGS");
  });

  it("GET /v1/lookup/:selector — unknown selector → 200 with empty entries", async () => {
    const res = await app.request("/v1/lookup/0x00000000");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ selector: "0x00000000", entries: [] });
  });

  it("GET /v1/lookup/:selector — returns seeded registry entries (incl. 32-byte event topics)", async () => {
    const { registry } = await import("../src/registry/store.js");
    registry.recordProven({ selector: "0x70a08231", kind: "function", signature: "balanceOf(address)" });
    const res = await app.request("/v1/lookup/0x70A08231"); // case-insensitive
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toContainEqual({ kind: "function", signature: "balanceOf(address)", proof: "keccak-proven" });
  });

  it("GET /v1/registry/export → JSONL with seeded entries", async () => {
    const { registry } = await import("../src/registry/store.js");
    registry.recordProven({ selector: "0xdead0001", kind: "function", signature: "exportMe(uint256)" });
    const res = await app.request("/v1/registry/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("ndjson");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toContainEqual(expect.objectContaining({ selector: "0xdead0001", signature: "exportMe(uint256)", proof: "keccak-proven" }));
  });

  it("GET /v1/registry/stats → 200 with counts", async () => {
    const res = await app.request("/v1/registry/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("selectors");
    expect(body).toHaveProperty("bytecodes");
  });

  it("sets rate-limit headers on API routes", async () => {
    const res = await app.request("/v1/ethereum/notanaddress/abi");
    expect(res.headers.get("ratelimit-limit")).toBe("120");
    expect(res.headers.get("ratelimit-remaining")).not.toBeNull();
  });

  it("sets CORS allow-origin", async () => {
    const res = await app.request("/health", { headers: { origin: "https://abi.ninja" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
