import { describe, it, expect } from "vitest";
import { safeStringify } from "../src/util.js";

describe("safeStringify", () => {
  it("serializes bigints as decimal strings", () => {
    expect(safeStringify({ a: 123n, b: "x" })).toBe('{"a":"123","b":"x"}');
  });

  it("handles nested bigints", () => {
    expect(safeStringify({ list: [1n, 2n] })).toBe('{"list":["1","2"]}');
  });
});
