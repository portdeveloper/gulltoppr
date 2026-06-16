/**
 * read_contract (SPEC §3) — call a view/pure function, return the decoded result.
 * No signer. Rejects state-mutating functions with NOT_A_VIEW_FN.
 */
import { decodeFunctionResult, encodeFunctionData, toFunctionSignature, type Hex } from "viem";
import { ApiError } from "../errors.js";
import type { Call } from "../types.js";
import { resolveAbiInternal } from "../resolve/index.js";
import { requireView, selectFunction } from "../resolve/selectFunction.js";
import { coerceArgs } from "./args.js";
import { trackMetric } from "../metrics.js";

export interface ReadResult {
  decoded: unknown[];
  raw: Hex;
  function_signature: string;
}

export async function readContract(call: Call, rpcOverride?: string): Promise<ReadResult> {
  const r = await resolveAbiInternal(call.chain, call.address, rpcOverride);
  const fn = selectFunction(r.abi, call.function);
  requireView(fn);
  const args = coerceArgs(fn, call.args);

  const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args });
  let raw: Hex;
  try {
    const res = await trackMetric("rpc.eth_call.read_contract", () => r.client.call({ to: call.address, data }));
    raw = (res.data ?? "0x") as Hex;
  } catch (e) {
    throw new ApiError("RPC_ERROR", `eth_call failed: ${(e as Error).message}`);
  }

  let decoded: unknown;
  try {
    decoded = decodeFunctionResult({ abi: [fn], functionName: fn.name, data: raw });
  } catch (e) {
    throw new ApiError("RPC_ERROR", `Could not decode return value: ${(e as Error).message}`);
  }

  return {
    decoded: Array.isArray(decoded) ? decoded : [decoded],
    raw,
    function_signature: toFunctionSignature(fn),
  };
}
