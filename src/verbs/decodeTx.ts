/**
 * decode_tx (SPEC §3, §8) — "explain what this tx did." Delegates to gulltoppr's
 * /v1/decode (heimdall trace/calldata decode), then best-effort layers the
 * resolved target ABI over the transaction calldata for named function/args.
 */
import {
  decodeFunctionData,
  toFunctionSelector,
  toFunctionSignature,
  type AbiFunction,
  type Address,
  type Hex,
} from "viem";
import { ApiError } from "../errors.js";
import { resolveChain } from "../chains.js";
import { getClient } from "../clients.js";
import { decodeTxViaHeimdall } from "../resolve/heimdall.js";
import { resolveAbiInternal } from "../resolve/index.js";
import { abiFunctions } from "../resolve/interface.js";
import { JsonCache } from "../cache.js";
import { chainRpcCacheScope } from "../cacheKey.js";
import type { DecodedCall, DecodeTxResult } from "../types.js";
import { trackMetric } from "../metrics.js";

// A transaction's calldata is immutable, so decodes can be cached effectively forever.
const decodeCache = new JsonCache<DecodeTxResult>("decode:");
const DECODE_TTL = 30 * 24 * 60 * 60; // 30 days

function selectedFunctionBySelector(functions: AbiFunction[], data: Hex): AbiFunction | undefined {
  const selector = data.slice(0, 10).toLowerCase();
  return functions.find((fn) => toFunctionSelector(fn).toLowerCase() === selector);
}

function jsonSafeValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, jsonSafeValue(nested)]));
  }
  return value;
}

async function tryDecodeCall(
  chainInput: number | string,
  txHash: Hex,
  rpcOverride?: string,
): Promise<DecodedCall | undefined> {
  try {
    const { client } = getClient(chainInput, rpcOverride);
    const tx = await trackMetric("rpc.getTransaction.decode_tx", () => client.getTransaction({ hash: txHash }));
    if (!tx.to || !tx.input || tx.input === "0x") return undefined;

    const r = await resolveAbiInternal(chainInput, tx.to, rpcOverride);
    const decoded = decodeFunctionData({ abi: r.abi, data: tx.input as Hex });
    const fn = selectedFunctionBySelector(abiFunctions(r.abi), tx.input as Hex);
    if (!fn) return undefined;
    const rawArgs = decoded.args ? [...decoded.args] : [];
    const inputs = fn.inputs ?? [];

    return {
      to: tx.to,
      function: String(decoded.functionName),
      signature: toFunctionSignature(fn),
      args: inputs.map((input, index) => ({
        name: input.name ?? "",
        type: input.type,
        value: jsonSafeValue(rawArgs[index]),
      })),
      abi_for: r.abiFor,
      provenance: r.provenance,
    };
  } catch {
    return undefined;
  }
}

export async function decodeTx(
  chainInput: number | string,
  txHash: string,
  rpcOverride?: string,
): Promise<DecodeTxResult> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new ApiError("INVALID_ADDRESS", `Not a valid tx hash: "${txHash}"`);
  }
  const resolved = resolveChain(chainInput, rpcOverride);
  const key = `${chainRpcCacheScope(resolved.id, resolved.rpcUrl)}:${txHash.toLowerCase()}`;
  const hit = decodeCache.get(key);
  if (hit) return { ...hit, cached: true };

  const out = await trackMetric("rung.heimdall.decode_tx", () => decodeTxViaHeimdall(txHash, resolved.rpcUrl));
  const decodedCall = await tryDecodeCall(chainInput, txHash as Hex, rpcOverride);
  const result: DecodeTxResult = {
    chain: resolved.id,
    tx_hash: txHash as Hex,
    source: out.source,
    cached: out.cached,
    decoded: out.decoded,
    provenance: { source: out.source, confidence: "decompiled", verified: false, names_synthetic: true },
    ...(decodedCall ? { decoded_call: decodedCall } : {}),
  };
  decodeCache.set(key, result, DECODE_TTL);
  return result;
}
