import { describe, it, expect } from "vitest";
import type { AbiFunction, AbiParameter } from "viem";
import { coerceArgs } from "../src/verbs/args.js";
import { ApiError } from "../src/errors.js";

const fn = (inputs: AbiParameter[]): AbiFunction =>
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

  it("validates address/string/bytes inputs before ABI encoding", () => {
    const addr = "0x0000000000000000000000000000000000000001";
    expect(coerceArgs(fn([
      { name: "a", type: "address" },
      { name: "s", type: "string" },
      { name: "b", type: "bytes" },
      { name: "b4", type: "bytes4" },
    ]), [addr, "hello", "0x1234", "0x12345678"])).toEqual([addr, "hello", "0x1234", "0x12345678"]);

    expect(() => coerceArgs(fn([{ name: "a", type: "address" }]), ["0xabc"])).toThrowError(ApiError);
    expect(() => coerceArgs(fn([{ name: "s", type: "string" }]), [123])).toThrowError(ApiError);
    expect(() => coerceArgs(fn([{ name: "b", type: "bytes" }]), ["0x123"])).toThrowError(ApiError);
    expect(() => coerceArgs(fn([{ name: "b4", type: "bytes4" }]), ["0x1234"])).toThrowError(ApiError);
    expect(() => coerceArgs(fn([{ name: "b", type: "bytes[]" }]), [["0x12", "bad"]])).toThrowError(ApiError);
  });

  it("recurses into arrays", () => {
    expect(coerceArgs(fn([{ name: "a", type: "uint256[]" }]), [["1", "2"]])).toEqual([[1n, 2n]]);
  });

  it("recurses into fixed arrays", () => {
    expect(coerceArgs(fn([{ name: "a", type: "bool[2]" }]), [["true", false]])).toEqual([[true, false]]);
    expect(() => coerceArgs(fn([{ name: "a", type: "uint256[2]" }]), [["1"]])).toThrowError(ApiError);
  });

  it("recurses into tuple objects and arrays", () => {
    const tuple = {
      name: "order",
      type: "tuple",
      components: [
        { name: "amount", type: "uint256" },
        { name: "enabled", type: "bool" },
      ],
    } as const;

    expect(coerceArgs(fn([tuple]), [{ amount: "5", enabled: "true" }])).toEqual([{ amount: 5n, enabled: true }]);
    expect(coerceArgs(fn([tuple]), [["6", false]])).toEqual([[6n, false]]);
  });

  it("recurses into tuple arrays", () => {
    const tupleArray = {
      name: "orders",
      type: "tuple[]",
      components: [
        { name: "amount", type: "uint256" },
        { name: "enabled", type: "bool" },
      ],
    } as const;

    expect(coerceArgs(fn([tupleArray]), [[{ amount: "5", enabled: "false" }]])).toEqual([[{ amount: 5n, enabled: false }]]);
  });

  it("rejects a wrong argument count", () => {
    expect(() => coerceArgs(fn([{ name: "a", type: "uint256" }]), [])).toThrowError(ApiError);
  });

  it("rejects an un-coercible uint", () => {
    expect(() => coerceArgs(fn([{ name: "a", type: "uint256" }]), ["notanumber"])).toThrowError(ApiError);
  });

  it("rejects non-decimal integer inputs instead of relying on JavaScript coercion", () => {
    expect(() => coerceArgs(fn([{ name: "a", type: "uint256" }]), [""])).toThrowError(ApiError);
    expect(() => coerceArgs(fn([{ name: "a", type: "uint256" }]), [true])).toThrowError(ApiError);
    expect(() => coerceArgs(fn([{ name: "a", type: "uint256" }]), ["0x10"])).toThrowError(ApiError);
    expect(() => coerceArgs(fn([{ name: "a", type: "uint256" }]), [Number.MAX_SAFE_INTEGER + 1])).toThrowError(ApiError);
    expect(coerceArgs(fn([{ name: "a", type: "uint256" }]), [Number.MAX_SAFE_INTEGER])).toEqual([BigInt(Number.MAX_SAFE_INTEGER)]);
  });

  it("rejects negative values for unsigned ints before ABI encoding", () => {
    expect(() => coerceArgs(fn([{ name: "a", type: "uint256" }]), ["-1"])).toThrowError(ApiError);
    expect(() => coerceArgs(fn([{ name: "a", type: "uint256[]" }]), [["1", "-2"]])).toThrowError(ApiError);
    expect(coerceArgs(fn([{ name: "a", type: "int256" }]), ["-1"])).toEqual([-1n]);
  });

  it("rejects integer values outside the ABI bit width before encoding", () => {
    expect(coerceArgs(fn([{ name: "a", type: "uint8" }]), ["255"])).toEqual([255n]);
    expect(() => coerceArgs(fn([{ name: "a", type: "uint8" }]), ["256"])).toThrowError(ApiError);

    expect(coerceArgs(fn([{ name: "a", type: "int8" }]), ["-128"])).toEqual([-128n]);
    expect(coerceArgs(fn([{ name: "a", type: "int8" }]), ["127"])).toEqual([127n]);
    expect(() => coerceArgs(fn([{ name: "a", type: "int8" }]), ["-129"])).toThrowError(ApiError);
    expect(() => coerceArgs(fn([{ name: "a", type: "int8" }]), ["128"])).toThrowError(ApiError);
  });

  it("treats uint and int aliases as 256-bit values", () => {
    const uintMax = (1n << 256n) - 1n;
    const intMin = -(1n << 255n);
    const intMax = (1n << 255n) - 1n;

    expect(coerceArgs(fn([{ name: "a", type: "uint" }]), [uintMax.toString()])).toEqual([uintMax]);
    expect(() => coerceArgs(fn([{ name: "a", type: "uint" }]), [(uintMax + 1n).toString()])).toThrowError(ApiError);
    expect(coerceArgs(fn([{ name: "a", type: "int" }]), [intMin.toString()])).toEqual([intMin]);
    expect(coerceArgs(fn([{ name: "a", type: "int" }]), [intMax.toString()])).toEqual([intMax]);
    expect(() => coerceArgs(fn([{ name: "a", type: "int" }]), [(intMax + 1n).toString()])).toThrowError(ApiError);
  });
});
