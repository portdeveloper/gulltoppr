import { describe, it, expect } from "vitest";
import { ApiError } from "../src/errors.js";

describe("ApiError", () => {
  it("maps codes to stable HTTP statuses", () => {
    expect(new ApiError("INVALID_ADDRESS", "x").status).toBe(400);
    expect(new ApiError("FUNCTION_NOT_FOUND", "x").status).toBe(404);
    expect(new ApiError("ABI_NOT_FOUND", "x").status).toBe(422);
    expect(new ApiError("DECOMPILE_FAILED", "x").status).toBe(502);
    expect(new ApiError("UPSTREAM_TIMEOUT", "x").status).toBe(504);
    expect(new ApiError("RATE_LIMITED", "x").status).toBe(429);
  });

  it("serializes to a stable envelope", () => {
    expect(new ApiError("INVALID_ARGS", "bad").toJSON()).toEqual({
      error: { code: "INVALID_ARGS", message: "bad" },
    });
  });

  it("includes details when present", () => {
    expect(new ApiError("AMBIGUOUS_FUNCTION", "ambig", { candidates: ["a()"] }).toJSON()).toEqual({
      error: { code: "AMBIGUOUS_FUNCTION", message: "ambig", details: { candidates: ["a()"] } },
    });
  });
});
