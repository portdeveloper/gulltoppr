export const AGENT_VERBS = [
  "resolve_abi",
  "read_contract",
  "encode_call",
  "simulate",
  "prepare_tx",
  "decode_tx",
  "resolve_name",
] as const;

export type AgentVerb = (typeof AGENT_VERBS)[number];

export const MCP_UTILITY_TOOLS = [
  "list_chains",
  "lookup_selector",
  "registry_stats",
  "export_registry",
  "runtime_metrics",
] as const;

export const MCP_TOOLS = [...AGENT_VERBS, ...MCP_UTILITY_TOOLS] as const;

export type McpTool = (typeof MCP_TOOLS)[number];
