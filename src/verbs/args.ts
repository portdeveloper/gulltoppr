/**
 * Coerce JSON args (strings/numbers from HTTP) into the types viem expects
 * (bigint for uint/int, boolean for bool, etc.) against an ABI function's inputs.
 * Maps any mismatch to INVALID_ARGS (SPEC §7).
 */
import type { AbiFunction, AbiParameter } from "viem";
import { ApiError } from "../errors.js";

function bytesLength(type: string): number | undefined {
  const match = type.match(/^bytes(\d+)$/);
  if (!match) return undefined;
  const length = Number(match[1]);
  if (!Number.isInteger(length) || length < 1 || length > 32) {
    throw new ApiError("INVALID_ARGS", `Invalid ABI bytes type ${type}`);
  }
  return length;
}

function assertHexBytes(value: string, type: string): void {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw new ApiError("INVALID_ARGS", `Cannot coerce "${String(value)}" to ${type}`);
  }
  const fixedLength = bytesLength(type);
  if (fixedLength !== undefined && (value.length - 2) / 2 !== fixedLength) {
    throw new ApiError("INVALID_ARGS", `Expected ${fixedLength} bytes for ${type}, got ${(value.length - 2) / 2}`);
  }
}

function coerceBigInt(value: unknown, type: string): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new ApiError("INVALID_ARGS", `Cannot coerce "${String(value)}" to ${type}`);
    }
    return BigInt(value);
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return BigInt(value);
  }
  throw new ApiError("INVALID_ARGS", `Cannot coerce "${String(value)}" to ${type}`);
}

function coerceOne(param: AbiParameter, value: unknown): unknown {
  const arrayMatch = param.type.match(/^(.*)\[(\d*)\]$/);
  if (arrayMatch) {
    if (!Array.isArray(value)) throw new ApiError("INVALID_ARGS", `Expected array for ${param.type}`);
    const expectedLength = arrayMatch[2] ? Number(arrayMatch[2]) : undefined;
    if (expectedLength !== undefined && value.length !== expectedLength) {
      throw new ApiError("INVALID_ARGS", `Expected ${expectedLength} values for ${param.type}, got ${value.length}`);
    }
    const base = { ...param, type: arrayMatch[1]! } as AbiParameter;
    return value.map((v) => coerceOne(base, v));
  }
  if (/^(u?int)(\d*)$/.test(param.type)) {
    const [, kind, widthText] = param.type.match(/^(u?int)(\d*)$/)!;
    const width = widthText ? Number(widthText) : 256;
    const coerced = coerceBigInt(value, param.type);
    if (kind === "uint" && coerced < 0n) {
      throw new ApiError("INVALID_ARGS", `Cannot coerce negative value "${coerced.toString()}" to ${param.type}`);
    }
    const bits = BigInt(width);
    if (kind === "uint") {
      const max = (1n << bits) - 1n;
      if (coerced > max) {
        throw new ApiError("INVALID_ARGS", `Value "${coerced.toString()}" exceeds ${param.type} max ${max.toString()}`);
      }
    } else {
      const min = -(1n << (bits - 1n));
      const max = (1n << (bits - 1n)) - 1n;
      if (coerced < min || coerced > max) {
        throw new ApiError("INVALID_ARGS", `Value "${coerced.toString()}" is outside ${param.type} range ${min.toString()}..${max.toString()}`);
      }
    }
    return coerced;
  }
  if (param.type === "bool") {
    if (typeof value === "boolean") return value;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new ApiError("INVALID_ARGS", `Cannot coerce "${String(value)}" to bool`);
  }
  if (param.type === "address") {
    if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new ApiError("INVALID_ARGS", `Cannot coerce "${String(value)}" to address`);
    }
    return value;
  }
  if (param.type === "string") {
    if (typeof value !== "string") {
      throw new ApiError("INVALID_ARGS", `Cannot coerce "${String(value)}" to string`);
    }
    return value;
  }
  if (param.type === "bytes" || /^bytes\d+$/.test(param.type)) {
    if (typeof value !== "string") {
      throw new ApiError("INVALID_ARGS", `Cannot coerce "${String(value)}" to ${param.type}`);
    }
    assertHexBytes(value, param.type);
    return value;
  }
  if (param.type === "tuple" && "components" in param && Array.isArray(param.components)) {
    if (Array.isArray(value)) {
      if (value.length !== param.components.length) {
        throw new ApiError("INVALID_ARGS", `Expected ${param.components.length} tuple values, got ${value.length}`);
      }
      return param.components.map((component, i) => coerceOne(component as AbiParameter, value[i]));
    }
    if (!value || typeof value !== "object") {
      throw new ApiError("INVALID_ARGS", "Expected object or array for tuple");
    }
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const component of param.components as readonly AbiParameter[]) {
      if (!component.name) throw new ApiError("INVALID_ARGS", "Tuple object args require named components");
      out[component.name] = coerceOne(component, input[component.name]);
    }
    return out;
  }
  // address / bytes / string — pass through (viem validates downstream).
  return value;
}

export function coerceArgs(fn: AbiFunction, args: unknown[]): unknown[] {
  const inputs = fn.inputs ?? [];
  if (args.length !== inputs.length) {
    throw new ApiError("INVALID_ARGS", `${fn.name} expects ${inputs.length} args, got ${args.length}`);
  }
  return inputs.map((input, i) => coerceOne(input, args[i]));
}
