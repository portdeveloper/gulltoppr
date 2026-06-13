/**
 * Client-side error: mirrors the engine's error envelope (SPEC §7). Carries the
 * stable machine `code` so callers can branch on it (e.g. retry on RPC_ERROR,
 * surface AMBIGUOUS_FUNCTION candidates).
 */
export type ErrorCode =
  | "INVALID_ADDRESS"
  | "INVALID_ARGS"
  | "UNKNOWN_CHAIN"
  | "AMBIGUOUS_FUNCTION"
  | "FUNCTION_NOT_FOUND"
  | "NOT_A_VIEW_FN"
  | "ABI_NOT_FOUND"
  | "DECOMPILE_FAILED"
  | "RPC_ERROR"
  | "UPSTREAM_TIMEOUT"
  | "RATE_LIMITED"
  | "INTERNAL"
  | "NETWORK";

export class AbiNinjaError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, status: number, details?: Record<string, unknown>) {
    super(message);
    this.name = "AbiNinjaError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
