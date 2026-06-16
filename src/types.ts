/**
 * Core data types for the engine — the JSON shapes from SPEC.md §2, expressed in
 * TypeScript. These are the contract the REST routes, MCP server, and npm SDK all
 * share. Keep this file in lockstep with SPEC.md §2.
 */
import type { Abi, AbiFunction, Address, Hex } from "viem";

// §2.2 — provenance, on every ABI-bearing result.
export type ProvenanceSource =
  | "etherscan"
  | "sourcify"
  | "proxy-impl"
  | "bytecode-match"
  | "heimdall-decompiled"
  | "4byte";

export type Confidence = "verified" | "partial" | "decompiled" | "selector-only";

export interface BytecodeMatchProvenance {
  /** EIP-155 chain id where the reusable bytecode skeleton was first resolved. */
  chain: number;
  /** Contract address whose metadata-stripped runtime bytecode matched this result. */
  address: Address;
  /** Original resolver source that produced the reused ABI. */
  source: ProvenanceSource;
  /** Original resolver confidence before clone/proxy confidence caps. */
  confidence: Confidence;
}

export interface Provenance {
  source: ProvenanceSource;
  confidence: Confidence;
  /** Source code was verified onchain. */
  verified: boolean;
  /** Function/param names may be synthetic (e.g. heimdall `Unresolved_0x…`). */
  names_synthetic: boolean;
  /** Human docs (NatSpec) available. */
  natspec: boolean;
  /** Present when ABI reuse came from an identical metadata-stripped runtime bytecode skeleton. */
  bytecode_match?: BytecodeMatchProvenance;
  notes?: string;
}

// §2.3 — proxy chain.
export type ProxyPattern =
  | "eip1967"
  | "uups"
  | "transparent"
  | "beacon"
  | "diamond"
  | "minimal-1167"
  | "unknown";

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

// §2.4a — the capability manifest ("the buttons"). The product, per SPEC §0.5.
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

// §2.4 — AbiResult, output of resolve_abi. `interface` is the headline; `abi` secondary.
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
  /** Address the ABI actually describes (implementation if classic proxy; proxy address for merged diamond ABIs). */
  abi_for: Address;
  cached: boolean;
}

export type CompactAbiResult = Omit<AbiResult, "abi"> & {
  /** Raw ABI intentionally omitted for token-efficient agent context. */
  abi_omitted: true;
};

// §2.5 — the shared call descriptor.
export interface Call {
  chain: number | string;
  address: Address;
  function: string;
  args: unknown[];
  value?: string;
  from?: Address;
}

// §2.6 — simulation.
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

// §2.7 — unsigned tx.
export interface UnsignedTx {
  chainId: number;
  to: Address;
  from: Address;
  data: Hex;
  value: string;
  gas?: string;
}

export interface WalletTransactionRequest {
  from: Address;
  to: Address;
  data: Hex;
  /** JSON-RPC quantity hex, ready for eth_sendTransaction. */
  value: Hex;
  /** JSON-RPC quantity hex, ready for eth_sendTransaction. */
  gas?: Hex;
}

export interface WalletRequest {
  /** Routing metadata; eth_sendTransaction itself still runs in the user's wallet. */
  chainId: number;
  method: "eth_sendTransaction";
  params: [WalletTransactionRequest];
}

export type PreparedTxRiskLevel = "low" | "medium" | "high" | "blocked";

export type PreparedTxSafetyReason =
  | "abi_names_inferred"
  | "proxy"
  | "simulation_failed"
  | "native_value"
  | "spending_approval"
  | "asset_outflow";

export interface PreparedTxSafety {
  signing_recommended: boolean;
  risk_level: PreparedTxRiskLevel;
  requires_human_confirmation: boolean;
  reasons: PreparedTxSafetyReason[];
}

// §2.8 — prepared tx (the hand-off payload).
export interface PreparedTx {
  unsigned_tx: UnsignedTx;
  simulation: Simulation;
  human_summary: string;
  deeplink: string;
  /** EIP-1193 request when signing is recommended. */
  wallet_request?: WalletRequest;
  /** Must show before signing. */
  warnings: string[];
  safety: PreparedTxSafety;
}

// §2.9 — decoded transaction.
export interface DecodeTxProvenance {
  source: string;
  confidence: "decompiled";
  verified: false;
  names_synthetic: true;
}

export interface DecodedCallArg extends IoParam {
  value: unknown;
}

export interface DecodedCall {
  to: Address;
  function: string;
  signature: string;
  args: DecodedCallArg[];
  abi_for: Address;
  provenance: Provenance;
}

export interface DecodeTxResult {
  chain: number;
  tx_hash: Hex;
  source: string;
  cached: boolean;
  decoded: unknown;
  provenance: DecodeTxProvenance;
  decoded_call?: DecodedCall;
}

/** Internal: an ABI resolution before manifest/token enrichment. Carries the raw
 * abi item list so callers (read/encode/etc.) can select functions. */
export interface ResolvedAbi {
  abi: Abi;
  functions: AbiFunction[];
  provenance: Provenance;
  proxy?: ProxyChain;
  abiFor: Address;
  cached: boolean;
}
