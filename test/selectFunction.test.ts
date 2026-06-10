import { describe, it, expect } from "vitest";
import type { Abi } from "viem";
import { selectFunction, requireView } from "../src/resolve/selectFunction.js";
import { ApiError } from "../src/errors.js";

const abi: Abi = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "a", type: "uint256" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "o", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "foo", stateMutability: "view", inputs: [{ name: "x", type: "uint256" }], outputs: [] },
  { type: "function", name: "foo", stateMutability: "view", inputs: [{ name: "x", type: "address" }], outputs: [] },
];

describe("selectFunction", () => {
  it("selects by bare name", () => {
    expect(selectFunction(abi, "transfer").name).toBe("transfer");
  });

  it("selects an overload by full signature", () => {
    expect(selectFunction(abi, "foo(address)").inputs[0]?.type).toBe("address");
  });

  it("throws AMBIGUOUS_FUNCTION for an overloaded bare name", () => {
    expect(() => selectFunction(abi, "foo")).toThrowError(/overloaded/i);
  });

  it("throws FUNCTION_NOT_FOUND for a missing function", () => {
    expect(() => selectFunction(abi, "nope")).toThrowError(ApiError);
  });
});

describe("requireView", () => {
  it("rejects state-mutating functions", () => {
    expect(() => requireView(selectFunction(abi, "transfer"))).toThrowError(/mutates/i);
  });

  it("allows view/pure functions", () => {
    expect(() => requireView(selectFunction(abi, "balanceOf"))).not.toThrow();
  });
});
