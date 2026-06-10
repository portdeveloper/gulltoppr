/**
 * Ladder rung 2 — Sourcify (SPEC §8). Pull the contract metadata.json; the ABI
 * lives at metadata.output.abi. full_match → verified; partial_match → partial.
 * Returns null on miss so the ladder falls through.
 */
import type { Abi, Address } from "viem";
import { config } from "../config.js";
import { fetchWithTimeout } from "../util.js";

export interface SourcifyHit {
  abi: Abi;
  match: "full" | "partial";
}

async function tryMatch(
  chainId: number,
  address: Address,
  kind: "full_match" | "partial_match",
): Promise<Abi | null> {
  const url = `https://repo.sourcify.dev/contracts/${kind}/${chainId}/${address}/metadata.json`;
  let res: Response;
  try {
    res = await fetchWithTimeout(url, config.sourcifyTimeoutMs, "Sourcify");
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const meta = (await res.json()) as { output?: { abi?: Abi } };
  return meta.output?.abi ?? null;
}

export async function fromSourcify(chainId: number, address: Address): Promise<SourcifyHit | null> {
  const full = await tryMatch(chainId, address, "full_match");
  if (full) return { abi: full, match: "full" };
  const partial = await tryMatch(chainId, address, "partial_match");
  if (partial) return { abi: partial, match: "partial" };
  return null;
}
