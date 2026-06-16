import { AGENT_VERBS, MCP_UTILITY_TOOLS } from "./agentSurface.js";
import { ERROR_CODES } from "./errors.js";

const json = (schema: unknown) => ({
  "application/json": { schema },
});

const param = (name: string, schema: unknown, description: string) => ({
  name,
  in: "path",
  required: true,
  description,
  schema,
});

const rpcParam = {
  name: "rpc_url",
  in: "query",
  required: false,
  description: "Override HTTP(S) RPC URL for the requested chain. Required for local or unlisted EVM chains.",
  schema: { type: "string", pattern: "^https?://\\S+$" },
};

const includeAbiParam = {
  name: "include_abi",
  in: "query",
  required: false,
  description: "Set false for a token-efficient manifest/provenance response that omits the raw JSON ABI.",
  schema: { type: "boolean", default: true },
};

const methodQueryParam = {
  name: "method_q",
  in: "query",
  required: false,
  description: "Case-insensitive substring filter across manifest method names, signatures, parameter names/types, outputs, and hints.",
  schema: { type: "string" },
};

const methodKindParam = {
  name: "method_kind",
  in: "query",
  required: false,
  description: "Restrict the returned manifest methods by read/write kind.",
  schema: { type: "string", enum: ["read", "write", "all"], default: "all" },
};

const methodLimitParam = {
  name: "method_limit",
  in: "query",
  required: false,
  description: "Maximum number of manifest methods to return after filtering.",
  schema: { type: "integer", minimum: 0, maximum: 500 },
};

const okJson = (schema: unknown, description = "OK") => ({
  description,
  content: json(schema),
});

const cacheControlHeader = {
  schema: { type: "string" },
  description: "Cache policy for this response. Operational endpoints use no-store; cacheable GETs include max-age and stale-while-revalidate.",
};

const rateLimitHeaders = {
  "RateLimit-Limit": { schema: { type: "integer", minimum: 0 }, description: "Fixed-window request budget for the current client." },
  "RateLimit-Remaining": { schema: { type: "integer", minimum: 0 }, description: "Requests remaining in the current fixed window." },
  "RateLimit-Reset": { schema: { type: "integer", minimum: 0 }, description: "Seconds until the current fixed window resets." },
};

const rateLimitErrorHeaders = {
  ...rateLimitHeaders,
  "Retry-After": { schema: { type: "integer", minimum: 0 }, description: "Seconds to wait before retrying after RATE_LIMITED." },
};

function withHeaders<T extends object>(response: T, headers: Record<string, unknown>): T & { headers: Record<string, unknown> } {
  const existing = "headers" in response && typeof response.headers === "object" && response.headers !== null
    ? response.headers as Record<string, unknown>
    : {};
  return { ...response, headers: { ...existing, ...headers } };
}

const cacheable = <T extends object>(response: T) => withHeaders(response, { "Cache-Control": cacheControlHeader });
const rateLimited = <T extends object>(response: T) => withHeaders(response, rateLimitHeaders);
const cacheableAndRateLimited = <T extends object>(response: T) => rateLimited(cacheable(response));

const errorResponses = {
  "400": { description: "Invalid input", content: json({ $ref: "#/components/schemas/ErrorEnvelope" }) },
  "404": { description: "Not found", content: json({ $ref: "#/components/schemas/ErrorEnvelope" }) },
  "422": { description: "ABI not found", content: json({ $ref: "#/components/schemas/ErrorEnvelope" }) },
  "429": { description: "Rate limited", headers: rateLimitErrorHeaders, content: json({ $ref: "#/components/schemas/ErrorEnvelope" }) },
  "502": { description: "Upstream failure", content: json({ $ref: "#/components/schemas/ErrorEnvelope" }) },
  "504": { description: "Upstream timeout", content: json({ $ref: "#/components/schemas/ErrorEnvelope" }) },
};

export const openApiSpec = {
  openapi: "3.1.0",
  info: {
    title: "gulltoppr REST API",
    version: "1.0.0",
    description:
      "Agent-facing EVM contract interaction API: resolve ABIs, read, encode, simulate, prepare unsigned transactions, decode transactions, resolve names, and export the selector commons.",
    license: { name: "MIT", identifier: "MIT" },
    contact: { name: "gulltoppr", url: "https://gulltoppr.dev" },
    "x-docs": "https://gulltoppr.dev/integrations.md",
    "x-llms": "https://gulltoppr.dev/llms.txt",
    "x-sdk": "https://www.npmjs.com/package/gulltoppr",
    "x-mcp-remote": "https://mcp.gulltoppr.dev/mcp",
    "x-mcp-metadata": ["https://mcp.gulltoppr.dev/server.json", "https://mcp.gulltoppr.dev/.well-known/mcp-server.json"],
    "x-repository": "https://github.com/portdeveloper/gulltoppr",
  },
  externalDocs: {
    description: "Integration recipes, agent workflow, MCP, SDK, and safety guidance.",
    url: "https://gulltoppr.dev/integrations.md",
  },
  servers: [
    { url: "https://api.gulltoppr.dev", description: "Production" },
    { url: "http://localhost:8787", description: "Local development" },
  ],
  tags: [
    { name: "contracts" },
    { name: "transactions" },
    { name: "names" },
    { name: "chains" },
    { name: "registry" },
    { name: "ops" },
  ],
  paths: {
    "/": {
      get: {
        tags: ["ops"],
        operationId: "discovery",
        summary: "Discovery document",
        responses: { "200": cacheable(okJson({ $ref: "#/components/schemas/Discovery" })) },
      },
    },
    "/health": {
      get: {
        tags: ["ops"],
        operationId: "health",
        summary: "Health check",
        responses: {
          "200": cacheable(okJson({
            type: "object",
            required: ["ok", "heimdallApi"],
            properties: { ok: { type: "boolean" }, heimdallApi: { type: "string", format: "uri" } },
          })),
        },
      },
    },
    "/openapi.json": {
      get: {
        tags: ["ops"],
        operationId: "openapi",
        summary: "OpenAPI contract",
        responses: { "200": { description: "OpenAPI 3.1 document", headers: { "Cache-Control": cacheControlHeader, ...rateLimitHeaders } } },
      },
    },
    "/llms.txt": {
      get: {
        tags: ["ops"],
        operationId: "llmsTxt",
        summary: "Agent-oriented text guide",
        responses: {
          "200": {
            description: "llms.txt guidance for coding agents and LLM workflows.",
            headers: { "Cache-Control": cacheControlHeader, ...rateLimitHeaders },
            content: { "text/plain": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/v1/metrics": {
      get: {
        tags: ["ops"],
        operationId: "metrics",
        summary: "Runtime resolver/RPC counters",
        responses: { "200": cacheableAndRateLimited(okJson({ $ref: "#/components/schemas/RuntimeMetrics" })) },
      },
    },
    "/v1/chains": {
      get: {
        tags: ["chains"],
        operationId: "chains",
        summary: "List supported chain aliases and defaults",
        parameters: [
          {
            name: "q",
            in: "query",
            schema: { type: "string" },
            required: false,
            description: "Case-insensitive search over chain id, name, aliases, and native symbol; multi-word queries match token-by-token and without whitespace.",
          },
          { name: "testnets", in: "query", schema: { type: "boolean" }, required: false },
          { name: "has_default_rpc", in: "query", schema: { type: "boolean" }, required: false },
        ],
        responses: {
          "200": cacheableAndRateLimited(okJson({
            type: "object",
            required: ["chains"],
            properties: { chains: { type: "array", items: { $ref: "#/components/schemas/ChainInfo" } } },
          })),
          ...errorResponses,
        },
      },
    },
    "/v1/lookup/{selector}": {
      get: {
        tags: ["registry"],
        operationId: "lookupSelector",
        summary: "Lookup proven signatures for a selector or event topic",
        parameters: [
          param("selector", { type: "string", pattern: "^0x([0-9a-fA-F]{8}|[0-9a-fA-F]{64})$" }, "4-byte selector or 32-byte event topic0."),
        ],
        responses: {
          "200": cacheableAndRateLimited(okJson({ $ref: "#/components/schemas/RegistryLookupResult" })),
          ...errorResponses,
        },
      },
    },
    "/v1/registry/stats": {
      get: {
        tags: ["registry"],
        operationId: "registryStats",
        summary: "Selector commons and bytecode index counts",
        responses: { "200": cacheableAndRateLimited(okJson({ $ref: "#/components/schemas/RegistryStats" })) },
      },
    },
    "/v1/registry/export": {
      get: {
        tags: ["registry"],
        operationId: "exportRegistry",
        summary: "CC0 selector commons export as NDJSON",
        responses: {
          "200": {
            description: "Newline-delimited RegistryExportEntry objects.",
            headers: {
              "Cache-Control": cacheControlHeader,
              ...rateLimitHeaders,
              "X-License": { schema: { type: "string", const: "CC0-1.0" } },
              Link: { schema: { type: "string" } },
            },
            content: {
              "application/x-ndjson": { schema: { type: "string" } },
            },
          },
        },
      },
    },
    "/v1/{chain}/{address}/abi": {
      get: {
        tags: ["contracts"],
        operationId: "resolveAbi",
        summary: "Resolve ABI, capability manifest, provenance, proxy chain, and token metadata",
        parameters: [
          { $ref: "#/components/parameters/Chain" },
          { $ref: "#/components/parameters/Address" },
          rpcParam,
          includeAbiParam,
          methodQueryParam,
          methodKindParam,
          methodLimitParam,
        ],
        responses: {
          "200": {
            ...okJson({
              oneOf: [
                { $ref: "#/components/schemas/AbiResult" },
                { $ref: "#/components/schemas/CompactAbiResult" },
              ],
            }),
            headers: {
              "Cache-Control": cacheControlHeader,
              ...rateLimitHeaders,
              "X-Source": { schema: { $ref: "#/components/schemas/ProvenanceSource" } },
              "X-Confidence": { schema: { $ref: "#/components/schemas/Confidence" } },
              "X-Cache": { schema: { type: "string", enum: ["HIT", "MISS"] } },
              "X-Elapsed-Ms": { schema: { type: "integer", minimum: 0 }, description: "Server-side resolve_abi elapsed milliseconds." },
              "X-ABI-Included": { schema: { type: "string", enum: ["true", "false"] }, description: "Whether the raw JSON ABI is included in the response body." },
            },
          },
          ...errorResponses,
        },
      },
    },
    "/v1/{chain}/{address}/read": {
      post: {
        tags: ["contracts"],
        operationId: "readContract",
        summary: "Call a view or pure function",
        parameters: [{ $ref: "#/components/parameters/Chain" }, { $ref: "#/components/parameters/Address" }, rpcParam],
        requestBody: { required: true, content: json({ $ref: "#/components/schemas/FunctionCallBody" }) },
        responses: { "200": rateLimited(okJson({ $ref: "#/components/schemas/ReadResult" })), ...errorResponses },
      },
    },
    "/v1/{chain}/{address}/encode": {
      post: {
        tags: ["contracts"],
        operationId: "encodeCall",
        summary: "Encode a function call to calldata",
        parameters: [{ $ref: "#/components/parameters/Chain" }, { $ref: "#/components/parameters/Address" }, rpcParam],
        requestBody: { required: true, content: json({ $ref: "#/components/schemas/EncodeCallBody" }) },
        responses: { "200": rateLimited(okJson({ $ref: "#/components/schemas/EncodeResult" })), ...errorResponses },
      },
    },
    "/v1/{chain}/simulate": {
      post: {
        tags: ["transactions"],
        operationId: "simulate",
        summary: "Simulate raw calldata or a high-level contract call",
        parameters: [{ $ref: "#/components/parameters/Chain" }, rpcParam],
        requestBody: { required: true, content: json({ $ref: "#/components/schemas/SimulateBody" }) },
        responses: { "200": rateLimited(okJson({ $ref: "#/components/schemas/Simulation" })), ...errorResponses },
      },
    },
    "/v1/{chain}/{address}/prepare": {
      post: {
        tags: ["transactions"],
        operationId: "prepareTx",
        summary: "Prepare an unsigned transaction with simulation and safety metadata",
        description:
          "Never signs or broadcasts. Returns unsigned_tx, simulation, human_summary, warnings, safety, a configured signing deeplink, and wallet_request when signing is recommended. Only hand off the deeplink or wallet_request when safety.signing_recommended is true; risk_level=blocked means do not send.",
        parameters: [{ $ref: "#/components/parameters/Chain" }, { $ref: "#/components/parameters/Address" }, rpcParam],
        requestBody: { required: true, content: json({ $ref: "#/components/schemas/PrepareTxBody" }) },
        responses: { "200": rateLimited(okJson({ $ref: "#/components/schemas/PreparedTx" })), ...errorResponses },
      },
    },
    "/v1/{chain}/tx/{hash}": {
      get: {
        tags: ["transactions"],
        operationId: "decodeTx",
        summary: "Decode and explain a transaction",
        parameters: [
          { $ref: "#/components/parameters/Chain" },
          param("hash", { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" }, "Transaction hash."),
          rpcParam,
        ],
        responses: { "200": cacheableAndRateLimited(okJson({ $ref: "#/components/schemas/DecodeTxResult" })), ...errorResponses },
      },
    },
    "/v1/{chain}/name/{name}": {
      get: {
        tags: ["names"],
        operationId: "resolveNameForward",
        summary: "Resolve ENS/Basename to address",
        parameters: [
          { $ref: "#/components/parameters/Chain" },
          param("name", { type: "string" }, "ENS or Basename."),
        ],
        responses: { "200": cacheableAndRateLimited(okJson({ $ref: "#/components/schemas/ResolveNameResult" })), ...errorResponses },
      },
    },
    "/v1/{chain}/name/by-address/{address}": {
      get: {
        tags: ["names"],
        operationId: "resolveNameReverse",
        summary: "Resolve address to primary ENS/Basename",
        parameters: [{ $ref: "#/components/parameters/Chain" }, { $ref: "#/components/parameters/Address" }],
        responses: { "200": cacheableAndRateLimited(okJson({ $ref: "#/components/schemas/ResolveNameResult" })), ...errorResponses },
      },
    },
  },
  components: {
    parameters: {
      Chain: { name: "chain", in: "path", required: true, schema: { oneOf: [{ type: "string" }, { type: "integer" }] } },
      Address: { name: "address", in: "path", required: true, schema: { $ref: "#/components/schemas/Address" } },
    },
    schemas: {
      Discovery: {
        type: "object",
        required: [
          "name",
          "website",
          "spec",
          "sdk",
          "openapi",
          "llms",
          "verbs",
          "mcp_utility_tools",
          "safety_gate",
          "chain_catalog",
          "metrics",
          "integrations",
        ],
        properties: {
          name: { type: "string", const: "gulltoppr engine" },
          website: { type: "string", format: "uri" },
          spec: { type: "string", format: "uri" },
          sdk: { type: "string", format: "uri" },
          openapi: { type: "string", const: "/openapi.json" },
          llms: { type: "string", const: "/llms.txt" },
          verbs: { type: "array", items: { type: "string", enum: AGENT_VERBS } },
          mcp_utility_tools: { type: "array", items: { type: "string", enum: MCP_UTILITY_TOOLS } },
          safety_gate: {
            type: "object",
            required: ["prepare_tx"],
            properties: {
              prepare_tx: {
                type: "string",
                description: "Agents must check safety.signing_recommended before presenting any signing hand-off.",
              },
            },
          },
          chain_catalog: { type: "string", const: "/v1/chains" },
          metrics: { type: "string", const: "/v1/metrics" },
          integrations: {
            type: "object",
            required: ["rest_openapi", "llms", "docs", "mcp_remote", "mcp_metadata"],
            properties: {
              rest_openapi: { type: "string", format: "uri" },
              llms: { type: "string", format: "uri" },
              docs: { type: "string", format: "uri" },
              mcp_remote: { type: "string", format: "uri" },
              mcp_metadata: { type: "array", items: { type: "string", format: "uri" } },
            },
          },
        },
      },
      Address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
      Hex: { type: "string", pattern: "^0x[0-9a-fA-F]*$" },
      TxHash: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
      SelectorOrTopic: { type: "string", pattern: "^0x([0-9a-fA-F]{8}|[0-9a-fA-F]{64})$" },
      Calldata: { type: "string", pattern: "^0x([0-9a-fA-F]{2})*$" },
      DecimalWei: { type: "string", pattern: "^\\d+$", description: "Native value in wei, decimal string." },
      SignedDecimal: { type: "string", pattern: "^-?\\d+$", description: "Signed decimal integer string." },
      FunctionName: { type: "string", minLength: 1, pattern: "\\S" },
      ErrorCode: {
        type: "string",
        enum: ERROR_CODES,
      },
      ErrorEnvelope: {
        type: "object",
        required: ["error"],
        properties: {
          error: {
            type: "object",
            required: ["code", "message"],
            properties: {
              code: { $ref: "#/components/schemas/ErrorCode" },
              message: { type: "string" },
              details: { type: "object", additionalProperties: true },
            },
          },
        },
      },
      ProvenanceSource: { type: "string", enum: ["etherscan", "sourcify", "proxy-impl", "bytecode-match", "heimdall-decompiled", "4byte"] },
      Confidence: { type: "string", enum: ["verified", "partial", "decompiled", "selector-only"] },
      BytecodeMatchProvenance: {
        type: "object",
        required: ["chain", "address", "source", "confidence"],
        description: "Original ABI source reused because the metadata-stripped runtime bytecode skeleton matched.",
        properties: {
          chain: { type: "integer", description: "EIP-155 chain id where the reusable bytecode skeleton was first resolved." },
          address: { $ref: "#/components/schemas/Address" },
          source: { $ref: "#/components/schemas/ProvenanceSource" },
          confidence: { $ref: "#/components/schemas/Confidence" },
        },
      },
      Provenance: {
        type: "object",
        required: ["source", "confidence", "verified", "names_synthetic", "natspec"],
        properties: {
          source: { $ref: "#/components/schemas/ProvenanceSource" },
          confidence: { $ref: "#/components/schemas/Confidence" },
          verified: { type: "boolean" },
          names_synthetic: { type: "boolean" },
          natspec: { type: "boolean" },
          bytecode_match: { $ref: "#/components/schemas/BytecodeMatchProvenance" },
          notes: { type: "string" },
        },
      },
      IoParam: {
        type: "object",
        required: ["name", "type"],
        properties: { name: { type: "string" }, type: { type: "string" } },
      },
      ReadCapability: {
        type: "object",
        required: ["function", "signature", "inputs", "outputs", "names_synthetic"],
        properties: {
          function: { type: "string" },
          signature: { type: "string" },
          inputs: { type: "array", items: { $ref: "#/components/schemas/IoParam" } },
          outputs: { type: "array", items: { $ref: "#/components/schemas/IoParam" } },
          names_synthetic: { type: "boolean" },
          hint: { type: "string" },
        },
      },
      WriteCapability: {
        type: "object",
        required: ["function", "signature", "inputs", "payable", "names_synthetic"],
        properties: {
          function: { type: "string" },
          signature: { type: "string" },
          inputs: { type: "array", items: { $ref: "#/components/schemas/IoParam" } },
          payable: { type: "boolean" },
          names_synthetic: { type: "boolean" },
          hint: { type: "string" },
        },
      },
      ContractInterface: {
        type: "object",
        required: ["reads", "writes"],
        properties: {
          reads: { type: "array", items: { $ref: "#/components/schemas/ReadCapability" } },
          writes: { type: "array", items: { $ref: "#/components/schemas/WriteCapability" } },
        },
      },
      ProxyChain: {
        type: "object",
        required: ["is_proxy", "pattern", "hops"],
        properties: {
          is_proxy: { type: "boolean", const: true },
          pattern: { type: "string", enum: ["eip1967", "uups", "transparent", "beacon", "diamond", "minimal-1167", "unknown"] },
          hops: {
            type: "array",
            items: {
              type: "object",
              required: ["address", "role"],
              properties: {
                address: { $ref: "#/components/schemas/Address" },
                role: { type: "string", enum: ["proxy", "implementation", "beacon", "facet"] },
              },
            },
          },
          resolved_implementation: { $ref: "#/components/schemas/Address" },
        },
      },
      TokenMeta: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { type: ["string", "null"], enum: ["erc20", "erc721", "erc1155", null] },
          symbol: { type: "string" },
          decimals: { type: "integer" },
          name: { type: "string" },
        },
      },
      AbiResult: {
        type: "object",
        required: ["chain", "address", "interface", "abi", "provenance", "abi_for", "cached"],
        properties: {
          chain: { type: "integer" },
          address: { $ref: "#/components/schemas/Address" },
          interface: { $ref: "#/components/schemas/ContractInterface" },
          abi: { type: "array", items: { type: "object", additionalProperties: true } },
          provenance: { $ref: "#/components/schemas/Provenance" },
          proxy: { $ref: "#/components/schemas/ProxyChain" },
          token: { $ref: "#/components/schemas/TokenMeta" },
          abi_for: { $ref: "#/components/schemas/Address" },
          cached: { type: "boolean" },
        },
      },
      CompactAbiResult: {
        type: "object",
        required: ["chain", "address", "interface", "provenance", "abi_for", "cached", "abi_omitted"],
        properties: {
          chain: { type: "integer" },
          address: { $ref: "#/components/schemas/Address" },
          interface: { $ref: "#/components/schemas/ContractInterface" },
          provenance: { $ref: "#/components/schemas/Provenance" },
          proxy: { $ref: "#/components/schemas/ProxyChain" },
          token: { $ref: "#/components/schemas/TokenMeta" },
          abi_for: { $ref: "#/components/schemas/Address" },
          cached: { type: "boolean" },
          abi_omitted: { type: "boolean", const: true },
        },
      },
      ChainInfo: {
        type: "object",
        required: ["id", "name", "aliases", "testnet", "has_default_rpc", "native_currency"],
        properties: {
          id: { type: "integer" },
          name: { type: "string" },
          aliases: { type: "array", items: { type: "string" } },
          testnet: { type: "boolean" },
          has_default_rpc: { type: "boolean" },
          default_rpc_url: { type: "string" },
          native_currency: {
            type: "object",
            required: ["name", "symbol", "decimals"],
            properties: { name: { type: "string" }, symbol: { type: "string" }, decimals: { type: "integer" } },
          },
          block_explorer_url: { type: "string" },
        },
      },
      FunctionCallBody: {
        type: "object",
        required: ["function"],
        properties: {
          function: { $ref: "#/components/schemas/FunctionName" },
          args: { type: "array", items: true, default: [] },
        },
      },
      EncodeCallBody: {
        allOf: [
          { $ref: "#/components/schemas/FunctionCallBody" },
          { type: "object", properties: { value: { $ref: "#/components/schemas/DecimalWei" } } },
        ],
      },
      PrepareTxBody: {
        allOf: [
          { $ref: "#/components/schemas/EncodeCallBody" },
          { type: "object", required: ["from"], properties: { from: { $ref: "#/components/schemas/Address" } } },
        ],
      },
      SimulateBody: {
        oneOf: [
          {
            type: "object",
            required: ["from", "to", "data"],
            not: { anyOf: [{ required: ["address"] }, { required: ["function"] }, { required: ["args"] }] },
            properties: {
              from: { $ref: "#/components/schemas/Address" },
              to: { $ref: "#/components/schemas/Address" },
              data: { $ref: "#/components/schemas/Calldata" },
              value: { $ref: "#/components/schemas/DecimalWei" },
            },
          },
          {
            type: "object",
            required: ["from", "address", "function"],
            not: { anyOf: [{ required: ["to"] }, { required: ["data"] }] },
            properties: {
              from: { $ref: "#/components/schemas/Address" },
              address: { $ref: "#/components/schemas/Address" },
              function: { $ref: "#/components/schemas/FunctionName" },
              args: { type: "array", items: true, default: [] },
              value: { $ref: "#/components/schemas/DecimalWei" },
            },
          },
        ],
      },
      ReadResult: {
        type: "object",
        required: ["decoded", "raw", "function_signature"],
        properties: { decoded: { type: "array", items: true }, raw: { $ref: "#/components/schemas/Calldata" }, function_signature: { type: "string" } },
      },
      EncodeResult: {
        type: "object",
        required: ["data", "function_signature"],
        properties: { data: { $ref: "#/components/schemas/Calldata" }, function_signature: { type: "string" } },
      },
      Simulation: {
        type: "object",
        required: ["success", "gas_used", "state_diff", "asset_changes", "logs"],
        properties: {
          success: { type: "boolean" },
          gas_used: { type: "integer", minimum: 0 },
          return_value: {
            type: "object",
            required: ["decoded", "raw"],
            properties: { decoded: { type: "array", items: true }, raw: { $ref: "#/components/schemas/Calldata" } },
          },
          state_diff: { type: "array", items: { $ref: "#/components/schemas/StateDiffEntry" } },
          asset_changes: { type: "array", items: { $ref: "#/components/schemas/AssetChange" } },
          logs: { type: "array", items: { $ref: "#/components/schemas/SimLog" } },
          revert: {
            type: "object",
            required: ["reason"],
            properties: { reason: { type: "string" }, decoded: { type: "string" } },
          },
        },
      },
      AssetChange: {
        type: "object",
        required: ["address", "token", "delta", "kind"],
        properties: {
          address: { $ref: "#/components/schemas/Address" },
          token: { $ref: "#/components/schemas/Address" },
          symbol: { type: "string" },
          delta: { $ref: "#/components/schemas/SignedDecimal" },
          kind: { type: "string", enum: ["erc20", "erc721", "erc1155", "native"] },
        },
      },
      StateDiffEntry: {
        type: "object",
        required: ["address", "before", "after"],
        properties: {
          address: { $ref: "#/components/schemas/Address" },
          slot_label: { type: "string" },
          before: { type: "string" },
          after: { type: "string" },
        },
      },
      SimLog: {
        type: "object",
        required: ["address"],
        properties: {
          address: { $ref: "#/components/schemas/Address" },
          event: { type: "string" },
          args: { type: "object", additionalProperties: true },
        },
      },
      UnsignedTx: {
        type: "object",
        required: ["chainId", "to", "from", "data", "value"],
        properties: {
          chainId: { type: "integer" },
          to: { $ref: "#/components/schemas/Address" },
          from: { $ref: "#/components/schemas/Address" },
          data: { $ref: "#/components/schemas/Calldata" },
          value: { $ref: "#/components/schemas/DecimalWei" },
          gas: { $ref: "#/components/schemas/DecimalWei" },
        },
      },
      WalletTransactionRequest: {
        type: "object",
        required: ["from", "to", "data", "value"],
        properties: {
          from: { $ref: "#/components/schemas/Address" },
          to: { $ref: "#/components/schemas/Address" },
          data: { $ref: "#/components/schemas/Calldata" },
          value: { $ref: "#/components/schemas/Hex", description: "JSON-RPC quantity hex." },
          gas: { $ref: "#/components/schemas/Hex", description: "JSON-RPC quantity hex." },
        },
      },
      WalletRequest: {
        type: "object",
        required: ["chainId", "method", "params"],
        properties: {
          chainId: { type: "integer", description: "Routing metadata; switch the wallet to this chain before requesting signature." },
          method: { type: "string", enum: ["eth_sendTransaction"] },
          params: {
            type: "array",
            minItems: 1,
            maxItems: 1,
            items: { $ref: "#/components/schemas/WalletTransactionRequest" },
          },
        },
      },
      PreparedTxSafety: {
        type: "object",
        required: ["signing_recommended", "risk_level", "requires_human_confirmation", "reasons"],
        properties: {
          signing_recommended: { type: "boolean", description: "True only when the simulation succeeded and the hand-off may be presented to the user." },
          risk_level: { type: "string", enum: ["low", "medium", "high", "blocked"], description: "blocked means do not send; high means require explicit human confirmation before presenting any hand-off." },
          requires_human_confirmation: { type: "boolean", description: "True when provenance, proxy, value, approval, or asset-outflow risks must be shown and confirmed by the user." },
          reasons: {
            type: "array",
            description: "Machine-readable warnings an agent must surface before any signing hand-off.",
            items: { type: "string", enum: ["abi_names_inferred", "proxy", "simulation_failed", "native_value", "spending_approval", "asset_outflow"] },
          },
        },
      },
      PreparedTx: {
        type: "object",
        required: ["unsigned_tx", "simulation", "human_summary", "deeplink", "warnings", "safety"],
        properties: {
          unsigned_tx: { $ref: "#/components/schemas/UnsignedTx" },
          simulation: { $ref: "#/components/schemas/Simulation" },
          human_summary: { type: "string" },
          deeplink: { type: "string", description: "Configured signing URL. Empty when safety.signing_recommended is false." },
          wallet_request: {
            $ref: "#/components/schemas/WalletRequest",
            description: "EIP-1193-shaped request for wallet/app integrations. Omitted when safety.signing_recommended is false.",
          },
          warnings: {
            type: "array",
            description: "Human-readable warnings an agent must show before presenting any signing hand-off.",
            items: { type: "string" },
          },
          safety: { $ref: "#/components/schemas/PreparedTxSafety" },
        },
      },
      DecodeTxResult: {
        type: "object",
        required: ["chain", "tx_hash", "source", "cached", "decoded", "provenance"],
        properties: {
          chain: { type: "integer" },
          tx_hash: { $ref: "#/components/schemas/TxHash" },
          source: { type: "string" },
          cached: { type: "boolean" },
          decoded: true,
          provenance: { $ref: "#/components/schemas/DecodeTxProvenance" },
          decoded_call: { $ref: "#/components/schemas/DecodedCall" },
        },
      },
      DecodeTxProvenance: {
        type: "object",
        required: ["source", "confidence", "verified", "names_synthetic"],
        properties: {
          source: { type: "string" },
          confidence: { type: "string", const: "decompiled" },
          verified: { type: "boolean", const: false },
          names_synthetic: { type: "boolean", const: true },
        },
      },
      DecodedCallArg: {
        allOf: [
          { $ref: "#/components/schemas/IoParam" },
          { type: "object", required: ["value"], properties: { value: true } },
        ],
      },
      DecodedCall: {
        type: "object",
        required: ["to", "function", "signature", "args", "abi_for", "provenance"],
        properties: {
          to: { $ref: "#/components/schemas/Address" },
          function: { type: "string" },
          signature: { type: "string" },
          args: { type: "array", items: { $ref: "#/components/schemas/DecodedCallArg" } },
          abi_for: { $ref: "#/components/schemas/Address" },
          provenance: { $ref: "#/components/schemas/Provenance" },
        },
      },
      ResolveNameResult: {
        type: "object",
        properties: { address: { $ref: "#/components/schemas/Address" }, name: { type: "string" } },
      },
      RegistryLookupEntry: {
        type: "object",
        required: ["kind", "signature", "proof"],
        properties: {
          kind: { type: "string", enum: ["function", "event", "error"] },
          signature: { type: "string" },
          proof: { type: "string", enum: ["verified-source", "keccak-proven"] },
          abi_item: { type: "object", additionalProperties: true },
          chain: { type: "integer", description: "EIP-155 chain id where a verified-source proof was harvested, when known." },
          address: { $ref: "#/components/schemas/Address" },
        },
      },
      RegistryExportEntry: {
        allOf: [
          { $ref: "#/components/schemas/RegistryLookupEntry" },
          {
            type: "object",
            required: ["selector"],
            properties: {
              selector: { $ref: "#/components/schemas/SelectorOrTopic" },
              chain: { type: "integer" },
              address: { $ref: "#/components/schemas/Address" },
            },
          },
        ],
      },
      RegistryLookupResult: {
        type: "object",
        required: ["selector", "entries"],
        properties: {
          selector: { $ref: "#/components/schemas/SelectorOrTopic" },
          entries: { type: "array", items: { $ref: "#/components/schemas/RegistryLookupEntry" } },
        },
      },
      RegistryStats: {
        type: "object",
        required: ["selectors", "bytecodes"],
        properties: { selectors: { type: "object", additionalProperties: { type: "integer", minimum: 0 } }, bytecodes: { type: "integer", minimum: 0 } },
      },
      MetricBucket: {
        type: "object",
        required: ["attempts", "successes", "misses", "failures", "total_latency_ms", "avg_latency_ms", "max_latency_ms", "failure_rate"],
        properties: {
          attempts: { type: "integer", minimum: 0 },
          successes: { type: "integer", minimum: 0 },
          misses: { type: "integer", minimum: 0 },
          failures: { type: "integer", minimum: 0 },
          total_latency_ms: { type: "integer", minimum: 0 },
          avg_latency_ms: { type: "integer", minimum: 0 },
          max_latency_ms: { type: "integer", minimum: 0 },
          failure_rate: { type: "number", minimum: 0, maximum: 1 },
          last_error: { type: "string" },
        },
      },
      RuntimeMetrics: {
        type: "object",
        required: ["uptime_seconds", "metrics"],
        properties: {
          uptime_seconds: { type: "integer", minimum: 0 },
          metrics: { type: "object", additionalProperties: { $ref: "#/components/schemas/MetricBucket" } },
        },
      },
    },
  },
} as const;
