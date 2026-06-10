/**
 * Resolve a `function` field (bare name OR full signature) against an ABI to a
 * single AbiFunction — SPEC §2.5. Throws FUNCTION_NOT_FOUND / AMBIGUOUS_FUNCTION /
 * NOT_A_VIEW_FN with the stable codes.
 */
import { toFunctionSignature, type Abi, type AbiFunction } from "viem";
import { ApiError } from "../errors.js";
import { abiFunctions } from "./interface.js";

export function selectFunction(abi: Abi, fnRef: string): AbiFunction {
  const fns = abiFunctions(abi);
  const isSignature = fnRef.includes("(");

  const matches = fns.filter((f) => {
    if (isSignature) {
      try {
        return toFunctionSignature(f) === fnRef;
      } catch {
        return false;
      }
    }
    return f.name === fnRef;
  });

  if (matches.length === 0) {
    throw new ApiError("FUNCTION_NOT_FOUND", `No function "${fnRef}" in the resolved ABI.`);
  }
  if (matches.length > 1) {
    throw new ApiError("AMBIGUOUS_FUNCTION", `"${fnRef}" is overloaded; pass the full signature.`, {
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
