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

  if (!BY_ID.has(chain.id)) BY_ID.set(chain.id, entry);
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
  default_rpc_url?: string;
  native_currency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  block_explorer_url?: string;
}

export function listChains(): ChainInfo[] {
  return [...BY_ID.values()]
    .sort((a, b) => a.chain.name.localeCompare(b.chain.name) || a.id - b.id)
    .map((entry) => ({
      id: entry.id,
      name: entry.chain.name,
      aliases: entry.aliases,
      ...(entry.defaultRpc ? { default_rpc_url: entry.defaultRpc } : {}),
      native_currency: entry.chain.nativeCurrency,
      ...(entry.chain.blockExplorers?.default?.url ? { block_explorer_url: entry.chain.blockExplorers.default.url } : {}),
    }));
}

/**
 * Resolve a chain input (alias string or numeric id) plus an optional rpc override
 * into a concrete { id, chain, rpcUrl }. Mirrors SPEC §6.
 */
export function resolveChain(input: number | string, rpcOverride?: string): ResolvedChain {
  let entry: ChainEntry | undefined;

  if (typeof input === "number" || /^\d+$/.test(String(input))) {
    entry = BY_ID.get(Number(input));
  } else {
    entry = ENTRIES[String(input).toLowerCase()];
  }

  const rpcUrl = rpcOverride || entry?.defaultRpc;
  if (!rpcUrl) {
    // Unknown chain id with no default and no override → genuinely unusable.
    if (!entry) {
      const id = Number(input);
      if (Number.isFinite(id)) {
        // Build an ad-hoc chain so arbitrary ids work *when* an rpc is supplied.
        throw new ApiError("UNKNOWN_CHAIN", `Unknown chain ${input} and no rpc_url supplied. Pass ?rpc_url= to use it.`);
      }
      throw new ApiError("UNKNOWN_CHAIN", `Unknown chain alias "${input}".`);
    }
    throw new ApiError("UNKNOWN_CHAIN", `Chain ${input} has no default RPC; pass ?rpc_url=.`);
  }

  if (entry) return { id: entry.id, chain: entry.chain, rpcUrl };

  // Arbitrary numeric id + rpc override: synthesize a chain.
  const id = Number(input);
  const chain = defineChain({
    id,
    name: `Chain ${id}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  return { id, chain, rpcUrl };
}
