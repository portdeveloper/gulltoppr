/**
 * decode_tx (SPEC §3, §8) — "explain what this tx did." Delegates to gulltoppr's
 * /v1/decode (heimdall trace/calldata decode) and wraps it with provenance.
 *
 * TODO: when the `to` contract is verified, layer the verified ABI over the decode
 * so events/params get real names (SPEC §8).
 */
import { ApiError } from "../errors.js";
import { resolveChain } from "../chains.js";
import { decodeTxViaHeimdall } from "../resolve/heimdall.js";
import { JsonCache } from "../cache.js";

// A transaction's calldata is immutable, so decodes can be cached effectively forever.
const decodeCache = new JsonCache<DecodeTxResult>("decode:");
const DECODE_TTL = 30 * 24 * 60 * 60; // 30 days

export interface DecodeTxResult {
  chain: number;
  tx_hash: string;
  source: string;
  cached: boolean;
  decoded: unknown;
  provenance: { source: string; confidence: "decompiled"; verified: false; names_synthetic: true };
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
  const key = `${resolved.id}:${txHash.toLowerCase()}`;
  const hit = decodeCache.get(key);
  if (hit) return { ...hit, cached: true };

  const out = await decodeTxViaHeimdall(txHash, resolved.rpcUrl);
  const result: DecodeTxResult = {
    chain: resolved.id,
    tx_hash: txHash,
    source: out.source,
    cached: out.cached,
    decoded: out.decoded,
    provenance: { source: out.source, confidence: "decompiled", verified: false, names_synthetic: true },
  };
  decodeCache.set(key, result, DECODE_TTL);
  return result;
}
