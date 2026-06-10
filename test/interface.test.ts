import { describe, it, expect } from "vitest";
import type { Abi } from "viem";
import { buildInterface } from "../src/resolve/interface.js";
import type { Provenance } from "../src/types.js";

const verified: Provenance = { source: "etherscan", confidence: "verified", verified: true, names_synthetic: false, natspec: true };
const decompiled: Provenance = { source: "heimdall-decompiled", confidence: "decompiled", verified: false, names_synthetic: true, natspec: false };

const abi: Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "name", stateMutability: "pure", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "event", name: "Transfer", inputs: [] },
];

describe("buildInterface", () => {
  it("splits reads (view/pure) from writes (mutating), ignoring events", () => {
    const i = buildInterface(abi, verified);
    expect(i.reads.map((r) => r.function).sort()).toEqual(["balanceOf", "name"]);
    expect(i.writes.map((w) => w.function).sort()).toEqual(["deposit", "transfer"]);
  });

  it("computes canonical signatures and the payable flag", () => {
    const i = buildInterface(abi, verified);
    expect(i.reads.find((r) => r.function === "balanceOf")?.signature).toBe("balanceOf(address)");
    expect(i.writes.find((w) => w.function === "deposit")?.payable).toBe(true);
    expect(i.writes.find((w) => w.function === "transfer")?.payable).toBe(false);
  });

  it("propagates names_synthetic from provenance", () => {
    const i = buildInterface(abi, decompiled);
    expect(i.reads.every((r) => r.names_synthetic)).toBe(true);
    expect(i.writes.every((w) => w.names_synthetic)).toBe(true);
  });

  it("adds an amount hint when token decimals are known", () => {
    const i = buildInterface(abi, verified, { kind: "erc20", symbol: "USDC", decimals: 6 });
    expect(i.writes.find((w) => w.function === "transfer")?.hint).toContain("6 decimals");
  });
});
