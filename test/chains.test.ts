import { describe, it, expect } from "vitest";
import { resolveChain } from "../src/chains.js";
import { ApiError } from "../src/errors.js";

describe("resolveChain", () => {
  it("resolves known aliases to chain ids", () => {
    expect(resolveChain("ethereum").id).toBe(1);
    expect(resolveChain("mainnet").id).toBe(1);
    expect(resolveChain("base").id).toBe(8453);
    expect(resolveChain("optimism").id).toBe(10);
    expect(resolveChain("arbitrum").id).toBe(42161);
    expect(resolveChain("polygon").id).toBe(137);
  });

  it("resolves numeric ids as number or string", () => {
    expect(resolveChain(1).id).toBe(1);
    expect(resolveChain("8453").id).toBe(8453);
  });

  it("provides a default RPC for known chains", () => {
    expect(resolveChain("ethereum").rpcUrl).toMatch(/^https?:\/\//);
  });

  it("honors an RPC override", () => {
    expect(resolveChain("base", "https://x.example").rpcUrl).toBe("https://x.example");
  });

  it("throws UNKNOWN_CHAIN for an unknown alias", () => {
    expect(() => resolveChain("notachain")).toThrowError(ApiError);
  });

  it("requires an RPC for local (31337)", () => {
    expect(() => resolveChain("local")).toThrow();
    expect(resolveChain("local", "http://127.0.0.1:8545").id).toBe(31337);
  });

  it("synthesizes an arbitrary chain id when given an RPC", () => {
    const c = resolveChain(8217, "https://rpc.example");
    expect(c.id).toBe(8217);
    expect(c.rpcUrl).toBe("https://rpc.example");
  });

  it("throws for an unknown numeric id without an RPC", () => {
    expect(() => resolveChain(8217)).toThrowError(ApiError);
  });
});
