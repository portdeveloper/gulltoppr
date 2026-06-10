/**
 * Coerce JSON args (strings/numbers from HTTP) into the types viem expects
 * (bigint for uint/int, boolean for bool, etc.) against an ABI function's inputs.
 * Maps any mismatch to INVALID_ARGS (SPEC §7).
 */
import type { AbiFunction } from "viem";
import { ApiError } from "../errors.js";

function coerceOne(type: string, value: unknown): unknown {
  if (type.endsWith("[]")) {
    if (!Array.isArray(value)) throw new ApiError("INVALID_ARGS", `Expected array for ${type}`);
    const base = type.slice(0, -2);
    return value.map((v) => coerceOne(base, v));
  }
  if (/^(u?int)(\d*)$/.test(type)) {
    try {
      return BigInt(value as string | number | bigint);
    } catch {
      throw new ApiError("INVALID_ARGS", `Cannot coerce "${String(value)}" to ${type}`);
    }
  }
  if (type === "bool") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new ApiError("INVALID_ARGS", `Cannot coerce "${String(value)}" to bool`);
  }
  // address / bytes / string / tuple — pass through (viem validates downstream).
  return value;
}

export function coerceArgs(fn: AbiFunction, args: unknown[]): unknown[] {
  const inputs = fn.inputs ?? [];
  if (args.length !== inputs.length) {
    throw new ApiError("INVALID_ARGS", `${fn.name} expects ${inputs.length} args, got ${args.length}`);
  }
  return inputs.map((input, i) => coerceOne(input.type, args[i]));
}
