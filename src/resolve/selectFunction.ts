/**
 * Resolve a `function` field (bare name OR full signature) against an ABI to a
 * single AbiFunction — SPEC §2.5. Throws FUNCTION_NOT_FOUND / AMBIGUOUS_FUNCTION /
 * NOT_A_VIEW_FN / NOT_A_WRITE_FN with the stable codes.
 */
import { toFunctionSignature, type Abi, type AbiFunction } from "viem";
import { ApiError } from "../errors.js";
import { abiFunctions } from "./interface.js";

function normalizeFunctionRef(fnRef: string): string {
  const trimmed = fnRef.trim();
  return trimmed.includes("(") ? trimmed.replace(/\s+/g, "") : trimmed;
}

export function selectFunction(abi: Abi, fnRef: string): AbiFunction {
  const fns = abiFunctions(abi);
  const normalizedRef = normalizeFunctionRef(fnRef);
  const isSignature = normalizedRef.includes("(");

  const matches = fns.filter((f) => {
    if (isSignature) {
      try {
        return toFunctionSignature(f) === normalizedRef;
      } catch {
        return false;
      }
    }
    return f.name === normalizedRef;
  });

  if (matches.length === 0) {
    throw new ApiError("FUNCTION_NOT_FOUND", `No function "${normalizedRef}" in the resolved ABI.`);
  }
  if (matches.length > 1) {
    throw new ApiError("AMBIGUOUS_FUNCTION", `"${normalizedRef}" is overloaded; pass the full signature.`, {
      candidates: matches.map((f) => toFunctionSignature(f)),
    });
  }
  return matches[0]!;
}

export function requireView(fn: AbiFunction): void {
  if (fn.stateMutability !== "view" && fn.stateMutability !== "pure") {
    throw new ApiError("NOT_A_VIEW_FN", `"${fn.name}" mutates state; use prepare_tx, not read_contract.`);
  }
}

export function requireWrite(fn: AbiFunction): void {
  if (fn.stateMutability === "view" || fn.stateMutability === "pure") {
    throw new ApiError("NOT_A_WRITE_FN", `"${fn.name}" is ${fn.stateMutability}; use read_contract, not prepare_tx.`);
  }
}
