import { describe, it, expect } from "vitest";
import { listChains, resolveChain } from "../src/chains.js";
import { ApiError } from "../src/errors.js";

describe("resolveChain", () => {
  it("resolves known aliases to chain ids", () => {
    expect(resolveChain("ethereum").id).toBe(1);
    expect(resolveChain("mainnet").id).toBe(1);
    expect(resolveChain("base").id).toBe(8453);
    expect(resolveChain("optimism").id).toBe(10);
    expect(resolveChain("arbitrum").id).toBe(42161);
    expect(resolveChain("polygon").id).toBe(137);
    expect(resolveChain("monad").id).toBe(143);
    expect(resolveChain("monad-mainnet").id).toBe(143);
    expect(resolveChain("monad-testnet").id).toBe(10143);
    expect(resolveChain("monadtestnet").id).toBe(10143);
  });

  it("resolves viem chain aliases beyond the hand-maintained set", () => {
    expect(resolveChain("bsc").id).toBe(56);
    expect(resolveChain("bnb-smart-chain").id).toBe(56);
    expect(resolveChain("sepolia").id).toBe(11155111);
    expect(resolveChain("viction").id).toBe(88);
  });

  it("resolves numeric ids as number or string", () => {
    expect(resolveChain(1).id).toBe(1);
    expect(resolveChain("8453").id).toBe(8453);
    expect(resolveChain("56").id).toBe(56);
  });

  it("provides a default RPC for known chains", () => {
    expect(resolveChain("ethereum").rpcUrl).toMatch(/^https?:\/\//);
    expect(resolveChain("bsc").rpcUrl).toMatch(/^https?:\/\//);
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

  it("lists known chains for UI clients", () => {
    const chains = listChains();
    expect(chains.length).toBeGreaterThan(100);
    expect(chains).toContainEqual(expect.objectContaining({
      id: 143,
      name: "Monad",
      aliases: expect.arrayContaining(["monad", "monad-mainnet"]),
      default_rpc_url: "https://rpc.monad.xyz",
    }));
    expect(chains).toContainEqual(expect.objectContaining({
      id: 56,
      name: "BNB Smart Chain",
      aliases: expect.arrayContaining(["bsc", "bnb-smart-chain"]),
    }));
  });

  it("throws for an unknown numeric id without an RPC", () => {
    expect(() => resolveChain(987654321)).toThrowError(ApiError);
  });
});
