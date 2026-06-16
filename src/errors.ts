/**
 * Typed, stable error model — SPEC.md §7. One ApiError class carrying a stable
 * machine `code`; the HTTP layer maps code → status. The same `code` shape is what
 * the MCP server will surface in its `isError` results.
 */

export const ERROR_CODES = [
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
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const STATUS: Record<ErrorCode, number> = {
  INVALID_ADDRESS: 400,
  INVALID_ARGS: 400,
  UNKNOWN_CHAIN: 400,
  AMBIGUOUS_FUNCTION: 400,
  FUNCTION_NOT_FOUND: 404,
  NOT_A_VIEW_FN: 400,
  NOT_A_WRITE_FN: 400,
  ABI_NOT_FOUND: 422,
  DECOMPILE_FAILED: 502,
  RPC_ERROR: 502,
  UPSTREAM_TIMEOUT: 504,
  RATE_LIMITED: 429,
};

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.details = details;
  }

  get status(): number {
    return STATUS[this.code];
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}
