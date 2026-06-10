/**
 * encode_call (SPEC §3) — pure ABI encode to calldata. Resolves the ABI, selects the
 * function, coerces args, returns calldata + canonical signature.
 */
import { encodeFunctionData, toFunctionSignature, type Hex } from "viem";
import type { Call } from "../types.js";
import { resolveAbiInternal } from "../resolve/index.js";
import { selectFunction } from "../resolve/selectFunction.js";
import { coerceArgs } from "./args.js";

export interface EncodeResult {
  data: Hex;
  function_signature: string;
}

export async function encodeCall(call: Call, rpcOverride?: string): Promise<EncodeResult> {
  const r = await resolveAbiInternal(call.chain, call.address, rpcOverride);
  const fn = selectFunction(r.abi, call.function);
  const args = coerceArgs(fn, call.args);
  const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args });
  return { data, function_signature: toFunctionSignature(fn) };
}
