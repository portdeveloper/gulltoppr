/**
 * Public wire types: the JSON the gulltoppr engine returns (SPEC.md §2). These
 * mirror the engine's `src/types.ts`; SPEC is the shared source of truth. Primitive
 * onchain types come from viem so consumers get the same branded `Address`/`Hex`.
 *
 * Note on numbers: the engine serializes bigints as decimal strings on the wire, so
 * fields like `decoded[]` / amounts arrive as strings, not bigints.
 */
import type { Abi, Address, Hex } from "viem";

export type ChainInput = number | string;

export type AgentVerb =
  | "resolve_abi"
  | "read_contract"
  | "encode_call"
  | "simulate"
  | "prepare_tx"
  | "decode_tx"
  | "resolve_name";

export type McpUtilityTool =
  | "list_chains"
  | "lookup_selector"
  | "registry_stats"
  | "export_registry"
  | "runtime_metrics";

export interface Discovery {
  name: string;
  website: string;
  spec: string;
  sdk: string;
  openapi: "/openapi.json";
  llms: "/llms.txt";
  verbs: AgentVerb[];
  mcp_utility_tools: McpUtilityTool[];
  safety_gate: {
    prepare_tx: string;
  };
  chain_catalog: "/v1/chains";
  metrics: "/v1/metrics";
  integrations: {
    rest_openapi: string;
    llms: string;
    docs: string;
    mcp_remote: string;
    mcp_metadata: string[];
  };
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

export interface MetricBucket {
  attempts: number;
  successes: number;
  misses: number;
  failures: number;
  total_latency_ms: number;
  avg_latency_ms: number;
  max_latency_ms: number;
  failure_rate: number;
  last_error?: string;
}

export interface RuntimeMetrics {
  uptime_seconds: number;
  metrics: Record<string, MetricBucket>;
}

export type SelectorKind = "function" | "event" | "error";
export type SelectorProof = "verified-source" | "keccak-proven";
export interface RegistryLookupEntry {
  kind: SelectorKind;
  signature: string;
  proof: SelectorProof;
  abi_item?: unknown;
  /** EIP-155 chain id where this proof was harvested, when known. */
  chain?: number;
  /** Contract address where this proof was harvested, when known. */
  address?: Address;
}
export interface RegistryLookupResult {
  selector: Hex;
  entries: RegistryLookupEntry[];
}
export interface RegistryExportEntry extends RegistryLookupEntry {
  selector: Hex;
}
export interface RegistryStats {
  selectors: Record<string, number>;
  bytecodes: number;
}

// §2.2
export type ProvenanceSource = "etherscan" | "sourcify" | "proxy-impl" | "bytecode-match" | "heimdall-decompiled" | "4byte";
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
  verified: boolean;
  names_synthetic: boolean;
  natspec: boolean;
  /** Present when ABI reuse came from an identical metadata-stripped runtime bytecode skeleton. */
  bytecode_match?: BytecodeMatchProvenance;
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
  /** Implementation for classic proxies; queried address for merged diamond ABIs. */
  abi_for: Address;
  cached: boolean;
}
export type CompactAbiResult = Omit<AbiResult, "abi"> & {
  /** Raw ABI intentionally omitted for token-efficient agent context. */
  abi_omitted: true;
};

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
  tx_hash: Hex;
  source: string;
  cached: boolean;
  decoded: unknown;
  provenance: DecodeTxProvenance;
  decoded_call?: DecodedCall;
}
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
export interface ResolveNameResult {
  address?: Address;
  name?: string;
}
