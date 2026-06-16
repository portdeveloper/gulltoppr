import { describe, it, expect } from "vitest";
import { ApiError, ERROR_CODES } from "../src/errors.js";

describe("ApiError", () => {
  it("exports the stable engine error code list", () => {
    expect(ERROR_CODES).toEqual([
      "INVALID_ADDRESS",
      "INVALID_ARGS",
      "UNKNOWN_CHAIN",
      "AMBIGUOUS_FUNCTION",
      "FUNCTION_NOT_FOUND",
      "NOT_A_VIEW_FN",
      "NOT_A_WRITE_FN",
      "ABI_NOT_FOUND",
      "DECOMPILE_FAILED",
      "RPC_ERROR",
      "UPSTREAM_TIMEOUT",
      "RATE_LIMITED",
    ]);
  });

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
