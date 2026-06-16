/**
 * Runtime configuration from env, with sane defaults. Mirrors gulltoppr's
 * env-with-defaults approach.
 */

function envString(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

function envNumber(key: string, fallback: number): number {
  const v = process.env[key];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: envNumber("PORT", 8787),

  /** gulltoppr — the heimdall decompile service (ladder rung 4). Already deployed. */
  heimdallApiUrl: envString("HEIMDALL_API_URL", "https://heimdall-api.fly.dev"),

  /** The deployed REST engine. The MCP server thin-clients this (shares its cache +
   * Etherscan key) instead of resolving in-process. */
  engineUrl: envString("ENGINE_URL", "https://api.gulltoppr.dev"),

  /** Mainnet RPC used for ENS/Basenames Universal Resolver calls. Basenames can be
   * computationally heavy, so production should set a private/mainnet RPC here. */
  ensRpcUrl: envString("ENS_RPC_URL", "https://ethereum-rpc.publicnode.com"),

  /** Single multichain Etherscan v2 key (ladder rung 1). Empty disables rung 1. */
  etherscanApiKey: envString("ETHERSCAN_API_KEY", ""),
  /** Per-process budget for the shared Etherscan key. 0 disables the budget. */
  etherscanRateLimit: envNumber("ETHERSCAN_RATE_LIMIT", 4),
  etherscanRateWindowMs: envNumber("ETHERSCAN_RATE_WINDOW_SEC", 1) * 1000,

  /** Base URL used to build prepare_tx hand-off deeplinks (SPEC §9). */
  signingBaseUrl: envString("SIGNING_BASE_URL", "https://abi.ninja"),

  /** Per-rung deadlines (ms). */
  etherscanTimeoutMs: envNumber("ETHERSCAN_TIMEOUT_MS", 8000),
  sourcifyTimeoutMs: envNumber("SOURCIFY_TIMEOUT_MS", 8000),
  heimdallTimeoutMs: envNumber("HEIMDALL_TIMEOUT_MS", 30000),
  /** Per-process cap on outbound gulltoppr/heimdall work. 0 disables the cap. */
  heimdallConcurrency: envNumber("HEIMDALL_CONCURRENCY", 2),
  heimdallQueueTimeoutMs: envNumber("HEIMDALL_QUEUE_TIMEOUT_MS", 5000),

  /** Per-IP rate limit (fixed window). ~2 req/s/IP by default, which keeps a flood
   * of distinct lookups within the shared Etherscan key's budget. Set RATE_LIMIT=0
   * to disable. RATE_LIMIT_ALLOW is a comma-separated IP allowlist (exempt). */
  rateLimitMax: envNumber("RATE_LIMIT", 120),
  rateLimitWindowMs: envNumber("RATE_LIMIT_WINDOW_SEC", 60) * 1000,
  rateLimitAllow: new Set(
    envString("RATE_LIMIT_ALLOW", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
} as const;
