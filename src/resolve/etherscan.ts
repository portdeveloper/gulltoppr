/**
 * Ladder rung 1 — Etherscan v2 (SPEC §8). One multichain endpoint keyed by
 * `chainid`. `getsourcecode` hands back the ABI *and* proxy/implementation hints in
 * one call, so we use it for both. Returns null on any miss (unverified, no key,
 * upstream error) so the ladder falls through.
 */
import type { Abi, Address } from "viem";
import { config } from "../config.js";
import { fetchWithTimeout } from "../util.js";

export interface EtherscanHit {
  abi: Abi;
  contractName?: string;
  natspec: boolean;
  /** Etherscan's own proxy hint, if any. */
  isProxy: boolean;
  implementation?: Address;
}

export async function fromEtherscan(chainId: number, address: Address): Promise<EtherscanHit | null> {
  if (!config.etherscanApiKey) return null;

  const url =
    `https://api.etherscan.io/v2/api?chainid=${chainId}` +
    `&module=contract&action=getsourcecode&address=${address}` +
    `&apikey=${config.etherscanApiKey}`;

  let res: Response;
  try {
    res = await fetchWithTimeout(url, config.etherscanTimeoutMs, "Etherscan");
  } catch {
    return null; // ladder is best-effort per rung; never let one rung 500 the request
  }
  if (!res.ok) return null;

  const body = (await res.json()) as { status: string; result: unknown };
  if (body.status !== "1" || !Array.isArray(body.result) || body.result.length === 0) return null;

  const r = body.result[0] as {
    ABI?: string;
    ContractName?: string;
    SourceCode?: string;
    Proxy?: string;
    Implementation?: string;
  };
  if (!r.ABI || r.ABI === "Contract source code not verified") return null;

  let abi: Abi;
  try {
    abi = JSON.parse(r.ABI) as Abi;
  } catch {
    return null;
  }

  return {
    abi,
    contractName: r.ContractName || undefined,
    // Verified source present ⇒ NatSpec is generally available.
    natspec: Boolean(r.SourceCode && r.SourceCode.length > 0),
    isProxy: r.Proxy === "1",
    implementation:
      r.Implementation && /^0x[0-9a-fA-F]{40}$/.test(r.Implementation)
        ? (r.Implementation as Address)
        : undefined,
  };
}
