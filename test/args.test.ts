import { describe, it, expect } from "vitest";
import type { AbiFunction } from "viem";
import { coerceArgs } from "../src/verbs/args.js";
import { ApiError } from "../src/errors.js";

const fn = (inputs: { name: string; type: string }[]): AbiFunction =>
  ({ type: "function", name: "f", stateMutability: "nonpayable", inputs, outputs: [] }) as AbiFunction;

describe("coerceArgs", () => {
  it("coerces uint/int to bigint", () => {
    expect(coerceArgs(fn([{ name: "a", type: "uint256" }, { name: "b", type: "int128" }]), ["1000000", 5])).toEqual([
      1000000n,
      5n,
    ]);
  });

  it("coerces bool from string or boolean", () => {
    expect(coerceArgs(fn([{ name: "a", type: "bool" }, { name: "b", type: "bool" }]), ["true", false])).toEqual([
      true,
      false,
    ]);
  });

  it("passes through address/string/bytes", () => {
    expect(coerceArgs(fn([{ name: "a", type: "address" }]), ["0xabc"])).toEqual(["0xabc"]);
  });

  it("recurses into arrays", () => {
    expect(coerceArgs(fn([{ name: "a", type: "uint256[]" }]), [["1", "2"]])).toEqual([[1n, 2n]]);
  });

  it("rejects a wrong argument count", () => {
    expect(() => coerceArgs(fn([{ name: "a", type: "uint256" }]), [])).toThrowError(ApiError);
  });

  it("rejects an un-coercible uint", () => {
    expect(() => coerceArgs(fn([{ name: "a", type: "uint256" }]), ["notanumber"])).toThrowError(ApiError);
  });
});
