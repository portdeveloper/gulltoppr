/** Small shared helpers. */
import { ApiError } from "./errors.js";

/** JSON stringify that survives viem's bigints (→ decimal strings). */
export function safeStringify(data: unknown, indent?: number): string {
  return JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), indent);
}

/** fetch with an AbortController timeout; maps timeout → UPSTREAM_TIMEOUT. */
export async function fetchWithTimeout(
  url: string,
  ms: number,
  label: string,
  init?: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      throw new ApiError("UPSTREAM_TIMEOUT", `${label} timed out after ${ms}ms`);
    }
    throw new ApiError("RPC_ERROR", `${label} request failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}
