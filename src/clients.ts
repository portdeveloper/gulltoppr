/**
 * viem PublicClient factory, cached per (chainId, rpcUrl). Clients are stateless
 * and cheap to share, so we memoize them for the process lifetime.
 */
import { createPublicClient, http, type PublicClient } from "viem";
import { mainnet, base } from "viem/chains";
import { resolveChain, type ResolvedChain } from "./chains.js";
import { config } from "./config.js";

const cache = new Map<string, PublicClient>();

export function getClient(chainInput: number | string, rpcOverride?: string): {
  client: PublicClient;
  resolved: ResolvedChain;
} {
  const resolved = resolveChain(chainInput, rpcOverride);
  const key = `${resolved.id}|${resolved.rpcUrl}`;
  let client = cache.get(key);
  if (!client) {
    // Cast to the bare PublicClient: chain-specific formatters (e.g. OP-stack
    // `deposit` tx type) otherwise make per-chain clients mutually unassignable.
    client = createPublicClient({
      chain: resolved.chain,
      transport: http(resolved.rpcUrl, { timeout: 15_000 }),
    }) as PublicClient;
    cache.set(key, client);
  }
  return { client, resolved };
}

/** Dedicated mainnet client for ENS (resolve_name). */
let ensClient: PublicClient | undefined;
export function getEnsClient(): PublicClient {
  if (!ensClient) {
    ensClient = createPublicClient({
      chain: mainnet,
      transport: http(config.ensRpcUrl, { timeout: 15_000 }),
    }) as PublicClient;
  }
  return ensClient;
}

/** Dedicated Base client for basename resolution. */
let baseClient: PublicClient | undefined;
export function getBaseClient(): PublicClient {
  if (!baseClient) {
    baseClient = createPublicClient({
      chain: base,
      transport: http("https://base-rpc.publicnode.com", { timeout: 15_000 }),
    }) as PublicClient;
  }
  return baseClient;
}
