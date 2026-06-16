/**
 * Chain table — SPEC.md §6. Maps an alias or numeric id to a chain id, a default
 * RPC, and a viem Chain object. Unknown ids are allowed *if* the caller supplies an
 * rpc_url (so local/31337 and arbitrary chains work); otherwise UNKNOWN_CHAIN.
 */
import * as viemChains from "viem/chains";
import { defineChain, type Chain } from "viem";
import { ApiError } from "./errors.js";

interface ChainEntry {
  id: number;
  chain: Chain;
  /** Default RPC; undefined means the caller MUST pass rpc_url (e.g. local). */
  defaultRpc?: string;
  aliases: string[];
}

const local = defineChain({
  id: 31337,
  name: "Local",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

const PREFERRED_RPC_BY_ID: Record<number, string | undefined> = {
  // publicnode hostnames are reliable from this environment (eth.llamarpc is not).
  1: "https://ethereum-rpc.publicnode.com",
  8453: "https://base-rpc.publicnode.com",
  10: "https://optimism-rpc.publicnode.com",
  42161: "https://arbitrum-one-rpc.publicnode.com",
  137: "https://polygon-bor-rpc.publicnode.com",
  143: "https://rpc.monad.xyz",
  10143: "https://testnet-rpc.monad.xyz",
  31337: undefined,
};

const EXTRA_ALIASES_BY_ID: Record<number, string[]> = {
  1: ["ethereum"],
  42161: ["arbitrum"],
  143: ["monad-mainnet"],
  10143: ["monad-testnet"],
};

function isChain(value: unknown): value is Chain {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as Chain).id === "number" &&
      typeof (value as Chain).name === "string" &&
      (value as Chain).nativeCurrency &&
      (value as Chain).rpcUrls,
  );
}

function kebab(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function aliasesFor(exportName: string, chain: Chain): string[] {
  return [
    exportName.toLowerCase(),
    kebab(exportName),
    kebab(chain.name),
    ...(EXTRA_ALIASES_BY_ID[chain.id] ?? []),
  ].filter((alias, index, all) => alias && all.indexOf(alias) === index);
}

function rpcFor(chain: Chain): string | undefined {
  if (Object.prototype.hasOwnProperty.call(PREFERRED_RPC_BY_ID, chain.id)) return PREFERRED_RPC_BY_ID[chain.id];
  return chain.rpcUrls.default.http[0];
}

const ENTRIES: Record<string, ChainEntry> = {};
const BY_ID = new Map<number, ChainEntry>();

function addEntry(exportName: string, chain: Chain) {
  const aliases = aliasesFor(exportName, chain);
  const entry: ChainEntry = {
    id: chain.id,
    chain,
    defaultRpc: rpcFor(chain),
    aliases,
  };

  if (exportName === "local" || !BY_ID.has(chain.id)) BY_ID.set(chain.id, entry);
  for (const alias of aliases) {
    ENTRIES[alias] ??= entry;
  }
}

for (const [exportName, chain] of Object.entries(viemChains)) {
  if (isChain(chain)) addEntry(exportName, chain);
}

addEntry("local", local);

export interface ResolvedChain {
  id: number;
  chain: Chain;
  /** The RPC to use: override > default. Throws UNKNOWN_CHAIN if neither exists. */
  rpcUrl: string;
}

export interface ChainInfo {
  id: number;
  name: string;
  aliases: string[];
  testnet: boolean;
  has_default_rpc: boolean;
  default_rpc_url?: string;
  native_currency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  block_explorer_url?: string;
}

export interface ChainListFilters {
  q?: string;
  testnets?: boolean;
  hasDefaultRpc?: boolean;
}

function looksLikeTestnet(name: string, aliases: string[]): boolean {
  const haystack = [name, ...aliases].join(" ").toLowerCase();
  return /\b(testnet|sepolia|goerli|holesky|hoodi|fuji|mumbai|amoy|devnet|local|anvil|hardhat)\b/.test(haystack);
}

function validateRpcUrl(rpcOverride?: string): string | undefined {
  if (rpcOverride === undefined) return undefined;
  try {
    if (/\s/.test(rpcOverride)) {
      throw new Error("whitespace is not allowed");
    }
    const url = new URL(rpcOverride);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return rpcOverride;
  } catch {
    throw new ApiError("INVALID_ARGS", "`rpc_url` must be an http(s) URL.");
  }
}

function numericChainId(input: number | string): number | undefined {
  if (typeof input === "number") {
    if (Number.isSafeInteger(input) && input > 0) return input;
    throw new ApiError("UNKNOWN_CHAIN", `Invalid chain id ${input}.`);
  }
  if (!/^\d+$/.test(input)) return undefined;
  const id = Number(input);
  if (Number.isSafeInteger(id) && id > 0) return id;
  throw new ApiError("UNKNOWN_CHAIN", `Invalid chain id ${input}.`);
}

function toChainInfo(entry: ChainEntry): ChainInfo {
  return {
    id: entry.id,
    name: entry.chain.name,
    aliases: entry.aliases,
    testnet: looksLikeTestnet(entry.chain.name, entry.aliases),
    has_default_rpc: Boolean(entry.defaultRpc),
    ...(entry.defaultRpc ? { default_rpc_url: entry.defaultRpc } : {}),
    native_currency: entry.chain.nativeCurrency,
    ...(entry.chain.blockExplorers?.default?.url ? { block_explorer_url: entry.chain.blockExplorers.default.url } : {}),
  };
}

function isTestnet(chain: ChainInfo): boolean {
  return chain.testnet;
}

function chainMatchesQuery(chain: ChainInfo, query: string): boolean {
  const haystack = `${chain.id} ${chain.name} ${chain.aliases.join(" ")} ${chain.native_currency.symbol}`.toLowerCase();
  if (haystack.includes(query)) return true;
  if (haystack.replace(/\s+/g, "").includes(query.replace(/\s+/g, ""))) return true;
  return query.split(/\s+/).every((token) => haystack.includes(token));
}

export function listChains(filters: ChainListFilters = {}): ChainInfo[] {
  const q = filters.q?.trim().toLowerCase();
  return [...BY_ID.values()]
    .map(toChainInfo)
    .filter((chain) => {
      if (filters.hasDefaultRpc === true && !chain.default_rpc_url) return false;
      if (filters.hasDefaultRpc === false && chain.default_rpc_url) return false;
      if (filters.testnets === false && isTestnet(chain)) return false;
      if (filters.testnets === true && !isTestnet(chain)) return false;
      if (q && !chainMatchesQuery(chain, q)) return false;
      return true;
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id - b.id);
}

/**
 * Resolve a chain input (alias string or numeric id) plus an optional rpc override
 * into a concrete { id, chain, rpcUrl }. Mirrors SPEC §6.
 */
export function resolveChain(input: number | string, rpcOverride?: string): ResolvedChain {
  let entry: ChainEntry | undefined;
  const rpcUrlOverride = validateRpcUrl(rpcOverride);
  const id = numericChainId(input);

  if (id !== undefined) {
    entry = BY_ID.get(id);
  } else {
    entry = ENTRIES[String(input).toLowerCase()];
  }

  const rpcUrl = rpcUrlOverride || entry?.defaultRpc;
  if (!rpcUrl) {
    // Unknown chain id with no default and no override → genuinely unusable.
    if (!entry) {
      if (id !== undefined) {
        // Build an ad-hoc chain so arbitrary ids work *when* an rpc is supplied.
        throw new ApiError("UNKNOWN_CHAIN", `Unknown chain ${input} and no rpc_url supplied. Pass ?rpc_url= to use it.`);
      }
      throw new ApiError("UNKNOWN_CHAIN", `Unknown chain alias "${input}".`);
    }
    throw new ApiError("UNKNOWN_CHAIN", `Chain ${input} has no default RPC; pass ?rpc_url=.`);
  }

  if (entry) return { id: entry.id, chain: entry.chain, rpcUrl };
  if (id === undefined) {
    throw new ApiError("UNKNOWN_CHAIN", `Unknown chain alias "${input}".`);
  }

  // Arbitrary numeric id + rpc override: synthesize a chain.
  const chain = defineChain({
    id,
    name: `Chain ${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  return { id, chain, rpcUrl };
}
