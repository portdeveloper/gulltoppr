/**
 * Chain table — SPEC.md §6. Maps an alias or numeric id to a chain id, a default
 * RPC, and a viem Chain object. Unknown ids are allowed *if* the caller supplies an
 * rpc_url (so local/31337 and arbitrary chains work); otherwise UNKNOWN_CHAIN.
 */
import {
  arbitrum,
  base,
  mainnet,
  optimism,
  polygon,
  type Chain,
} from "viem/chains";
import { defineChain } from "viem";
import { ApiError } from "./errors.js";

interface ChainEntry {
  id: number;
  chain: Chain;
  /** Default RPC; undefined means the caller MUST pass rpc_url (e.g. local). */
  defaultRpc?: string;
}

const monad = defineChain({
  id: 143,
  name: "Monad",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "MonadVision", url: "https://monadvision.com" } },
});

const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "MonadVision Testnet", url: "https://testnet.monadvision.com" } },
});

// publicnode hostnames are reliable from this environment (eth.llamarpc is not).
const ENTRIES: Record<string, ChainEntry> = {
  ethereum: { id: 1, chain: mainnet, defaultRpc: "https://ethereum-rpc.publicnode.com" },
  mainnet: { id: 1, chain: mainnet, defaultRpc: "https://ethereum-rpc.publicnode.com" },
  base: { id: 8453, chain: base, defaultRpc: "https://base-rpc.publicnode.com" },
  optimism: { id: 10, chain: optimism, defaultRpc: "https://optimism-rpc.publicnode.com" },
  arbitrum: { id: 42161, chain: arbitrum, defaultRpc: "https://arbitrum-one-rpc.publicnode.com" },
  polygon: { id: 137, chain: polygon, defaultRpc: "https://polygon-bor-rpc.publicnode.com" },
  monad: { id: 143, chain: monad, defaultRpc: "https://rpc.monad.xyz" },
  "monad-mainnet": { id: 143, chain: monad, defaultRpc: "https://rpc.monad.xyz" },
  "monad-testnet": { id: 10143, chain: monadTestnet, defaultRpc: "https://testnet-rpc.monad.xyz" },
  monadtestnet: { id: 10143, chain: monadTestnet, defaultRpc: "https://testnet-rpc.monad.xyz" },
  local: { id: 31337, chain: defineChain({ id: 31337, name: "Local", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } } }) },
};

const BY_ID: Record<number, ChainEntry> = Object.fromEntries(
  Object.values(ENTRIES).map((e) => [e.id, e]),
);

export interface ResolvedChain {
  id: number;
  chain: Chain;
  /** The RPC to use: override > default. Throws UNKNOWN_CHAIN if neither exists. */
  rpcUrl: string;
}

/**
 * Resolve a chain input (alias string or numeric id) plus an optional rpc override
 * into a concrete { id, chain, rpcUrl }. Mirrors SPEC §6.
 */
export function resolveChain(input: number | string, rpcOverride?: string): ResolvedChain {
  let entry: ChainEntry | undefined;

  if (typeof input === "number" || /^\d+$/.test(String(input))) {
    entry = BY_ID[Number(input)];
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
