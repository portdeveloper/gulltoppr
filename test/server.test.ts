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
