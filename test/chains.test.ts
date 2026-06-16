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
    expect(resolveChain("base", "http://127.0.0.1:8545").rpcUrl).toBe("http://127.0.0.1:8545");
  });

  it("rejects invalid RPC overrides before building a client", () => {
    expect(() => resolveChain("base", "not-a-url")).toThrowError(ApiError);
    expect(() => resolveChain("base", "ws://rpc.example")).toThrowError(ApiError);
    expect(() => resolveChain("base", "https://rpc.example/a b")).toThrowError(ApiError);
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

  it("requires the rpc_url escape hatch to use a numeric chain id", () => {
    expect(() => resolveChain("notachain", "https://rpc.example")).toThrowError(ApiError);
    expect(() => resolveChain("", "https://rpc.example")).toThrowError(ApiError);
  });

  it("rejects invalid numeric chain ids even with an RPC override", () => {
    expect(() => resolveChain(0, "https://rpc.example")).toThrowError(ApiError);
    expect(() => resolveChain(-1, "https://rpc.example")).toThrowError(ApiError);
    expect(() => resolveChain(Number.NaN, "https://rpc.example")).toThrowError(ApiError);
    expect(() => resolveChain("9007199254740992", "https://rpc.example")).toThrowError(ApiError);
  });

  it("lists known chains for UI clients", () => {
    const chains = listChains();
    expect(chains.length).toBeGreaterThan(100);
    expect(chains).toContainEqual(expect.objectContaining({
      id: 143,
      name: "Monad",
      aliases: expect.arrayContaining(["monad", "monad-mainnet"]),
      testnet: false,
      has_default_rpc: true,
      default_rpc_url: "https://rpc.monad.xyz",
    }));
    expect(chains).toContainEqual(expect.objectContaining({
      id: 56,
      name: "BNB Smart Chain",
      aliases: expect.arrayContaining(["bsc", "bnb-smart-chain"]),
      testnet: false,
      has_default_rpc: true,
    }));
  });

  it("filters listed chains by query, testnet status, and default RPC", () => {
    expect(listChains({ q: "monad" }).map((c) => c.id)).toEqual(expect.arrayContaining([143, 10143]));
    expect(listChains({ q: "monad", testnets: false }).map((c) => c.id)).toContain(143);
    expect(listChains({ q: "monad", testnets: false }).map((c) => c.id)).not.toContain(10143);
    expect(listChains({ q: "monad", testnets: true })).toContainEqual(expect.objectContaining({ id: 10143, testnet: true }));
    expect(listChains({ q: "bnb chain" })).toContainEqual(expect.objectContaining({ id: 56, name: "BNB Smart Chain" }));
    expect(listChains({ q: "bnbsmart" })).toContainEqual(expect.objectContaining({ id: 56, name: "BNB Smart Chain" }));
    expect(listChains({ q: "local", hasDefaultRpc: true }).map((c) => c.id)).not.toContain(31337);
    expect(listChains({ q: "local", hasDefaultRpc: false })).toContainEqual(expect.objectContaining({ id: 31337, has_default_rpc: false }));
  });

  it("throws for an unknown numeric id without an RPC", () => {
    expect(() => resolveChain(987654321)).toThrowError(ApiError);
  });
});
