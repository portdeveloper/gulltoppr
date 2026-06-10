/**
 * Public wire types — the JSON the abi.ninja engine returns (SPEC.md §2). These
 * mirror the engine's `src/types.ts`; SPEC is the shared source of truth. Primitive
 * onchain types come from viem so consumers get the same branded `Address`/`Hex`.
 *
 * Note on numbers: the engine serializes bigints as decimal strings on the wire, so
 * fields like `decoded[]` / amounts arrive as strings, not bigints.
 */
import type { Abi, Address, Hex } from "viem";

export type ChainInput = number | string;

// §2.2
export type ProvenanceSource = "etherscan" | "sourcify" | "proxy-impl" | "bytecode-match" | "heimdall-decompiled" | "4byte";
export type Confidence = "verified" | "partial" | "decompiled" | "selector-only";
export interface Provenance {
  source: ProvenanceSource;
  confidence: Confidence;
  verified: boolean;
  names_synthetic: boolean;
  natspec: boolean;
  notes?: string;
}

// §2.3
export type ProxyPattern = "eip1967" | "uups" | "transparent" | "beacon" | "diamond" | "minimal-1167" | "unknown";
export interface ProxyHop {
  address: Address;
  role: "proxy" | "implementation" | "beacon" | "facet";
}
export interface ProxyChain {
  is_proxy: true;
  pattern: ProxyPattern;
  hops: ProxyHop[];
  resolved_implementation?: Address;
}

// §2.4a
export interface IoParam {
  name: string;
  type: string;
}
export interface ReadCapability {
  function: string;
  signature: string;
  inputs: IoParam[];
  outputs: IoParam[];
  names_synthetic: boolean;
  hint?: string;
}
export interface WriteCapability {
  function: string;
  signature: string;
  inputs: IoParam[];
  payable: boolean;
  names_synthetic: boolean;
  hint?: string;
}
export interface ContractInterface {
  reads: ReadCapability[];
  writes: WriteCapability[];
}

// §2.4
export interface TokenMeta {
  kind: "erc20" | "erc721" | "erc1155" | null;
  symbol?: string;
  decimals?: number;
  name?: string;
}
export interface AbiResult {
  chain: number;
  address: Address;
  interface: ContractInterface;
  abi: Abi;
  provenance: Provenance;
  proxy?: ProxyChain;
  token?: TokenMeta;
  abi_for: Address;
  cached: boolean;
}

// §2.6
export interface AssetChange {
  address: Address;
  token: Address;
  symbol?: string;
  delta: string;
  kind: "erc20" | "erc721" | "erc1155" | "native";
}
export interface StateDiffEntry {
  address: Address;
  slot_label?: string;
  before: string;
  after: string;
}
export interface SimLog {
  address: Address;
  event?: string;
  args?: Record<string, unknown>;
}
export interface Simulation {
  success: boolean;
  gas_used: number;
  return_value?: { decoded: unknown[]; raw: Hex };
  state_diff: StateDiffEntry[];
  asset_changes: AssetChange[];
  logs: SimLog[];
  revert?: { reason: string; decoded?: string };
}

// §2.7 / §2.8
export interface UnsignedTx {
  chainId: number;
  to: Address;
  from: Address;
  data: Hex;
  value: string;
  gas?: string;
}
export interface PreparedTx {
  unsigned_tx: UnsignedTx;
  simulation: Simulation;
  human_summary: string;
  deeplink: string;
  warnings: string[];
}

// Verb-specific results
export interface ReadResult {
  decoded: unknown[];
  raw: Hex;
  function_signature: string;
}
export interface EncodeResult {
  data: Hex;
  function_signature: string;
}
export interface DecodeTxResult {
  chain: number;
  tx_hash: string;
  source: string;
  cached: boolean;
  decoded: unknown;
  provenance: { source: string; confidence: "decompiled"; verified: false; names_synthetic: true };
}
export interface ResolveNameResult {
  address?: Address;
  name?: string;
}
