/**
 * Ladder rung 4 — heimdall decompile via gulltoppr (SPEC §8). THE MOAT: yields a
 * usable ABI for unverified contracts. We call gulltoppr's deployed HTTP endpoint
 * rather than embedding heimdall (keeps the decompile subprocess isolated).
 *
 * gulltoppr GET /v1/{address}?rpc_url= → { address, source, cached, elapsed_ms, abi }
 */
import type { Abi, Address } from "viem";
import { ApiError } from "../errors.js";
import { config } from "../config.js";
import { fetchWithTimeout } from "../util.js";
import { UpstreamConcurrency } from "../upstreamConcurrency.js";

export interface HeimdallHit {
  abi: Abi;
  cached: boolean;
}

const heimdallConcurrency = new UpstreamConcurrency(config.heimdallConcurrency);

export async function fromHeimdall(address: Address, rpcUrl: string): Promise<HeimdallHit | null> {
  return heimdallConcurrency.run("gulltoppr", config.heimdallQueueTimeoutMs, () =>
    fromHeimdallUnbounded(address, rpcUrl),
  );
}

async function fromHeimdallUnbounded(address: Address, rpcUrl: string): Promise<HeimdallHit | null> {
  const url = `${config.heimdallApiUrl}/v1/${address}?rpc_url=${encodeURIComponent(rpcUrl)}`;

  const res = await fetchWithTimeout(url, config.heimdallTimeoutMs, "gulltoppr");

  if (res.status === 422) return null; // no bytecode / nothing to decompile → ladder falls through
  if (res.status === 502 || res.status === 504) {
    throw new ApiError("DECOMPILE_FAILED", "gulltoppr failed to decompile the bytecode.");
  }
  if (!res.ok) return null;

  const body = (await res.json()) as { abi?: Abi; cached?: boolean };
  if (!body.abi || !Array.isArray(body.abi) || body.abi.length === 0) return null;
  return { abi: body.abi, cached: Boolean(body.cached) };
}

/** decode_tx path (SPEC §8): gulltoppr GET /v1/decode/{tx_hash}?rpc_url= */
export async function decodeTxViaHeimdall(
  txHash: string,
  rpcUrl: string,
): Promise<{ source: string; cached: boolean; decoded: unknown }> {
  return heimdallConcurrency.run("gulltoppr decode", config.heimdallQueueTimeoutMs, () =>
    decodeTxViaHeimdallUnbounded(txHash, rpcUrl),
  );
}

async function decodeTxViaHeimdallUnbounded(
  txHash: string,
  rpcUrl: string,
): Promise<{ source: string; cached: boolean; decoded: unknown }> {
  const url = `${config.heimdallApiUrl}/v1/decode/${txHash}?rpc_url=${encodeURIComponent(rpcUrl)}`;
  const res = await fetchWithTimeout(url, config.heimdallTimeoutMs, "gulltoppr decode");
  if (res.status === 502 || res.status === 504) {
    throw new ApiError("DECOMPILE_FAILED", "gulltoppr failed to decode the transaction.");
  }
  if (!res.ok) {
    throw new ApiError("RPC_ERROR", `gulltoppr decode returned ${res.status}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  return {
    source: String(body.source ?? "heimdall-decoded"),
    cached: Boolean(body.cached),
    decoded: body.decoded ?? body,
  };
}
