import { describe, it, expect } from "vitest";
import { toFunctionSelector } from "viem";
import { AGENT_VERBS, MCP_UTILITY_TOOLS } from "../src/agentSurface.js";
import { ERROR_CODES } from "../src/errors.js";
import { app, cacheControlForAbi } from "../src/server.js";

const ADDR = "0x0000000000000000000000000000000000000001";

// These exercise the HTTP plumbing — routing, the typed error → HTTP status mapping,
// the error envelope, CORS, and rate-limit headers — via validation paths that fail
// before any network call (so no mocking / no upstreams needed).
describe("HTTP layer", () => {
  it("GET /health → 200 ok", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ ok: true });
  });

  it("GET / → root discovery payload", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    expect(await res.json()).toMatchObject({
      name: "gulltoppr engine",
      website: "https://gulltoppr.dev",
      spec: "https://github.com/portdeveloper/gulltoppr/blob/main/SPEC.md",
      sdk: "https://www.npmjs.com/package/gulltoppr",
      openapi: "/openapi.json",
      llms: "/llms.txt",
      verbs: AGENT_VERBS,
      mcp_utility_tools: MCP_UTILITY_TOOLS,
      safety_gate: {
        prepare_tx: expect.stringContaining("safety.signing_recommended"),
      },
      chain_catalog: "/v1/chains",
      metrics: "/v1/metrics",
      integrations: {
        rest_openapi: "https://api.gulltoppr.dev/openapi.json",
        llms: "https://gulltoppr.dev/llms.txt",
        docs: "https://gulltoppr.dev/integrations.md",
        mcp_remote: "https://mcp.gulltoppr.dev/mcp",
        mcp_metadata: expect.arrayContaining([
          "https://mcp.gulltoppr.dev/server.json",
          "https://mcp.gulltoppr.dev/.well-known/mcp-server.json",
        ]),
      },
    });
  });

  it("GET /llms.txt → compact agent guide", async () => {
    const res = await app.request("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    const text = await res.text();
    expect(text).toContain("# gulltoppr");
    expect(text).toContain("https://api.gulltoppr.dev/openapi.json");
    expect(text).toContain("safety.signing_recommended");
    expect(text).toContain("import { Gulltoppr }");
  });

  it("GET /v1/metrics → 200 with runtime counters", async () => {
    const res = await app.request("/v1/metrics");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      uptime_seconds: expect.any(Number),
      metrics: expect.any(Object),
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("GET /openapi.json → OpenAPI contract for the public REST surface", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    const spec = await res.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers).toContainEqual(expect.objectContaining({ url: "https://api.gulltoppr.dev" }));
    expect(spec.externalDocs).toEqual({
      description: "Integration recipes, agent workflow, MCP, SDK, and safety guidance.",
      url: "https://gulltoppr.dev/integrations.md",
    });
    expect(spec.info.contact).toEqual({ name: "gulltoppr", url: "https://gulltoppr.dev" });
    expect(spec.info["x-docs"]).toBe("https://gulltoppr.dev/integrations.md");
    expect(spec.info["x-llms"]).toBe("https://gulltoppr.dev/llms.txt");
    expect(spec.info["x-sdk"]).toBe("https://www.npmjs.com/package/gulltoppr");
    expect(spec.info["x-mcp-remote"]).toBe("https://mcp.gulltoppr.dev/mcp");
    expect(spec.info["x-mcp-metadata"]).toEqual([
      "https://mcp.gulltoppr.dev/server.json",
      "https://mcp.gulltoppr.dev/.well-known/mcp-server.json",
    ]);
    expect(spec.info["x-repository"]).toBe("https://github.com/portdeveloper/gulltoppr");
    expect(Object.keys(spec.paths).sort()).toEqual([
      "/",
      "/health",
      "/llms.txt",
      "/openapi.json",
      "/v1/chains",
      "/v1/lookup/{selector}",
      "/v1/metrics",
      "/v1/registry/export",
      "/v1/registry/stats",
      "/v1/{chain}/name/by-address/{address}",
      "/v1/{chain}/name/{name}",
      "/v1/{chain}/simulate",
      "/v1/{chain}/tx/{hash}",
      "/v1/{chain}/{address}/abi",
      "/v1/{chain}/{address}/encode",
      "/v1/{chain}/{address}/prepare",
      "/v1/{chain}/{address}/read",
    ]);
    expect(spec.components.schemas.Discovery.properties.verbs.items.enum).toEqual(AGENT_VERBS);
    expect(spec.components.schemas.Discovery.properties.mcp_utility_tools.items.enum).toEqual(MCP_UTILITY_TOOLS);
    expect(spec.components.schemas.Discovery.properties.safety_gate.properties.prepare_tx.description).toContain("safety.signing_recommended");
    expect(spec.components.schemas.Discovery.properties.integrations.properties.mcp_metadata.items).toEqual({ type: "string", format: "uri" });
    expect(spec.paths["/health"].get.responses["200"].headers["Cache-Control"].description).toContain("Cache policy");
    expect(spec.paths["/openapi.json"].get.responses["200"].headers["Cache-Control"].description).toContain("Cache policy");
    expect(spec.paths["/openapi.json"].get.responses["200"].headers["RateLimit-Limit"].description).toContain("request budget");
    expect(spec.paths["/v1/chains"].get.responses["200"].headers["Cache-Control"].description).toContain("Cache policy");
    expect(spec.paths["/v1/chains"].get.responses["200"].headers["RateLimit-Remaining"].description).toContain("Requests remaining");
    expect(spec.paths["/v1/metrics"].get.responses["200"].headers["Cache-Control"].description).toContain("Operational endpoints");
    expect(spec.paths["/v1/{chain}/{address}/read"].post.responses["200"].headers["RateLimit-Reset"].description).toContain("window resets");
    expect(spec.paths["/v1/{chain}/tx/{hash}"].get.responses["200"].headers["Cache-Control"].description).toContain("Cache policy");
    expect(spec.paths["/v1/{chain}/{address}/abi"].get.responses["429"].headers["Retry-After"].description).toContain("RATE_LIMITED");
    expect(spec.paths["/v1/{chain}/{address}/abi"].get.responses["429"].headers["RateLimit-Limit"].description).toContain("request budget");
    expect(spec.paths["/v1/{chain}/{address}/abi"].get.responses["429"].headers["RateLimit-Remaining"].description).toContain("Requests remaining");
    expect(spec.paths["/v1/{chain}/{address}/abi"].get.responses["429"].headers["RateLimit-Reset"].description).toContain("window resets");
    expect(spec.paths["/v1/{chain}/{address}/prepare"].post.description).toContain("configured signing deeplink");
    expect(spec.paths["/v1/{chain}/{address}/prepare"].post.description).toContain("safety.signing_recommended");
    expect(spec.paths["/v1/{chain}/{address}/prepare"].post.description).toContain("risk_level=blocked means do not send");
    expect(spec.components.schemas.PreparedTx.required).toContain("safety");
    expect(spec.components.schemas.PreparedTxSafety.properties.reasons.items.enum).toContain("asset_outflow");
    expect(spec.components.schemas.PreparedTxSafety.properties.reasons.items.enum).toContain("spending_approval");
    expect(spec.components.schemas.PreparedTxSafety.properties.reasons.description).toContain("agent must surface");
    expect(spec.components.schemas.PreparedTxSafety.properties.risk_level.description).toContain("blocked means do not send");
    expect(spec.components.schemas.PreparedTx.properties.deeplink.description).toContain("Empty when safety.signing_recommended is false");
    expect(spec.components.schemas.PreparedTx.properties.wallet_request.description).toContain("Omitted");
    expect(spec.components.schemas.PreparedTx.properties.warnings.description).toContain("agent must show");
    expect(spec.components.schemas.ErrorCode.enum).toEqual(ERROR_CODES);
    expect(spec.paths["/v1/{chain}/{address}/abi"].get.parameters).toContainEqual(expect.objectContaining({ name: "include_abi" }));
    expect(spec.paths["/v1/{chain}/{address}/abi"].get.parameters).toContainEqual(expect.objectContaining({ name: "method_q" }));
    expect(spec.paths["/v1/{chain}/{address}/abi"].get.parameters).toContainEqual(
      expect.objectContaining({
        name: "method_kind",
        schema: { type: "string", enum: ["read", "write", "all"], default: "all" },
      }),
    );
    expect(spec.paths["/v1/{chain}/{address}/abi"].get.parameters).toContainEqual(
      expect.objectContaining({
        name: "method_limit",
        schema: { type: "integer", minimum: 0, maximum: 500 },
      }),
    );
    expect(spec.paths["/v1/{chain}/{address}/abi"].get.parameters).toContainEqual(
      expect.objectContaining({
        name: "rpc_url",
        schema: { type: "string", pattern: "^https?://\\S+$" },
      }),
    );
    expect(spec.paths["/v1/{chain}/{address}/abi"].get.responses["200"].headers["X-Elapsed-Ms"]).toMatchObject({
      schema: { type: "integer", minimum: 0 },
    });
    expect(spec.paths["/v1/{chain}/{address}/abi"].get.responses["200"].headers["Cache-Control"].description).toContain("Cache policy");
    expect(spec.paths["/v1/{chain}/{address}/abi"].get.responses["200"].headers["RateLimit-Limit"].description).toContain("request budget");
    expect(spec.paths["/v1/{chain}/{address}/abi"].get.responses["200"].headers["X-ABI-Included"]).toMatchObject({
      schema: { type: "string", enum: ["true", "false"] },
    });
    expect(spec.components.schemas.ChainInfo.required).toEqual(expect.arrayContaining(["testnet", "has_default_rpc"]));
    expect(spec.components.schemas.CompactAbiResult.required).toContain("abi_omitted");
    expect(spec.components.schemas.BytecodeMatchProvenance.required).toEqual(["chain", "address", "source", "confidence"]);
    expect(spec.components.schemas.BytecodeMatchProvenance.properties.address).toEqual({ $ref: "#/components/schemas/Address" });
    expect(spec.components.schemas.Provenance.properties.bytecode_match).toEqual({ $ref: "#/components/schemas/BytecodeMatchProvenance" });
    expect(spec.components.schemas.WalletRequest.properties.method.enum).toEqual(["eth_sendTransaction"]);
    expect(spec.components.schemas.RegistryLookupEntry.properties.proof.enum).toEqual(["verified-source", "keccak-proven"]);
    expect(spec.components.schemas.RegistryLookupEntry.properties.chain).toMatchObject({
      type: "integer",
      description: expect.stringContaining("verified-source proof"),
    });
    expect(spec.components.schemas.RegistryLookupEntry.properties.address).toEqual({ $ref: "#/components/schemas/Address" });
    expect(spec.components.schemas.RegistryExportEntry.allOf).toEqual([
      { $ref: "#/components/schemas/RegistryLookupEntry" },
      expect.objectContaining({
        required: ["selector"],
        properties: expect.objectContaining({
          selector: { $ref: "#/components/schemas/SelectorOrTopic" },
          chain: { type: "integer" },
          address: { $ref: "#/components/schemas/Address" },
        }),
      }),
    ]);
    expect(spec.paths["/v1/registry/export"].get.responses["200"].description).toContain("RegistryExportEntry");
    expect(spec.components.schemas.FunctionName).toMatchObject({ minLength: 1, pattern: "\\S" });
    expect(spec.components.schemas.DecimalWei.pattern).toBe("^\\d+$");
    expect(spec.components.schemas.SignedDecimal.pattern).toBe("^-?\\d+$");
    expect(spec.components.schemas.TxHash.pattern).toBe("^0x[0-9a-fA-F]{64}$");
    expect(spec.components.schemas.SelectorOrTopic.pattern).toBe("^0x([0-9a-fA-F]{8}|[0-9a-fA-F]{64})$");
    expect(spec.components.schemas.Calldata.pattern).toBe("^0x([0-9a-fA-F]{2})*$");
    expect(spec.components.schemas.TokenMeta.properties.decimals).toEqual({ type: "integer" });
    expect(spec.components.schemas.DecodeTxResult.properties.tx_hash).toEqual({ $ref: "#/components/schemas/TxHash" });
    expect(spec.components.schemas.DecodeTxResult.properties.provenance).toEqual({ $ref: "#/components/schemas/DecodeTxProvenance" });
    expect(spec.components.schemas.DecodeTxResult.properties.decoded_call).toEqual({ $ref: "#/components/schemas/DecodedCall" });
    expect(spec.components.schemas.DecodeTxProvenance.required).toEqual(["source", "confidence", "verified", "names_synthetic"]);
    expect(spec.components.schemas.DecodeTxProvenance.properties.confidence).toEqual({ type: "string", const: "decompiled" });
    expect(spec.components.schemas.DecodeTxProvenance.properties.verified).toEqual({ type: "boolean", const: false });
    expect(spec.components.schemas.DecodeTxProvenance.properties.names_synthetic).toEqual({ type: "boolean", const: true });
    expect(spec.components.schemas.DecodedCall.properties.args.items).toEqual({ $ref: "#/components/schemas/DecodedCallArg" });
    expect(spec.components.schemas.DecodedCall.properties.provenance).toEqual({ $ref: "#/components/schemas/Provenance" });
    expect(spec.components.schemas.RegistryLookupResult.properties.selector).toEqual({ $ref: "#/components/schemas/SelectorOrTopic" });
    expect(spec.components.schemas.ReadResult.properties.raw).toEqual({ $ref: "#/components/schemas/Calldata" });
    expect(spec.components.schemas.EncodeResult.properties.data).toEqual({ $ref: "#/components/schemas/Calldata" });
    expect(spec.components.schemas.Simulation.properties.gas_used).toEqual({ type: "integer", minimum: 0 });
    expect(spec.components.schemas.Simulation.properties.return_value.properties.raw).toEqual({ $ref: "#/components/schemas/Calldata" });
    expect(spec.components.schemas.AssetChange.properties.delta).toEqual({ $ref: "#/components/schemas/SignedDecimal" });
    expect(spec.components.schemas.UnsignedTx.properties.data).toEqual({ $ref: "#/components/schemas/Calldata" });
    expect(spec.components.schemas.UnsignedTx.properties.value).toEqual({ $ref: "#/components/schemas/DecimalWei" });
    expect(spec.components.schemas.UnsignedTx.properties.gas).toEqual({ $ref: "#/components/schemas/DecimalWei" });
    expect(spec.components.schemas.WalletTransactionRequest.properties.data).toEqual({ $ref: "#/components/schemas/Calldata" });
    expect(spec.components.schemas.RegistryStats.properties.bytecodes).toEqual({ type: "integer", minimum: 0 });
    expect(spec.components.schemas.RegistryStats.properties.selectors.additionalProperties).toEqual({ type: "integer", minimum: 0 });
    expect(spec.components.schemas.MetricBucket.properties.attempts).toEqual({ type: "integer", minimum: 0 });
    expect(spec.components.schemas.MetricBucket.properties.failure_rate).toEqual({ type: "number", minimum: 0, maximum: 1 });
    expect(spec.components.schemas.RuntimeMetrics.properties.uptime_seconds).toEqual({ type: "integer", minimum: 0 });
    expect(spec.components.schemas.FunctionCallBody.properties.function).toEqual({ $ref: "#/components/schemas/FunctionName" });
    expect(spec.components.schemas.EncodeCallBody.allOf[1].properties.value).toEqual({ $ref: "#/components/schemas/DecimalWei" });
    expect(spec.components.schemas.SimulateBody.oneOf).toEqual([
      expect.objectContaining({ required: ["from", "to", "data"] }),
      expect.objectContaining({ required: ["from", "address", "function"] }),
    ]);
    expect(spec.components.schemas.SimulateBody.oneOf[0].not).toEqual({
      anyOf: [{ required: ["address"] }, { required: ["function"] }, { required: ["args"] }],
    });
    expect(spec.components.schemas.SimulateBody.oneOf[1].not).toEqual({
      anyOf: [{ required: ["to"] }, { required: ["data"] }],
    });
  });

  it("invalid address → 400 INVALID_ADDRESS envelope", async () => {
    const res = await app.request("/v1/ethereum/notanaddress/abi");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ADDRESS");
  });

  it("invalid path addresses on REST verbs → 400 INVALID_ADDRESS before upstream work", async () => {
    const cases: Array<{ path: string; method?: "GET" | "POST"; body?: unknown }> = [
      { path: "/v1/notachain/notanaddress/read", method: "POST", body: { function: "balanceOf", args: [ADDR] } },
      { path: "/v1/notachain/notanaddress/encode", method: "POST", body: { function: "transfer", args: [ADDR, "1"] } },
      { path: "/v1/notachain/notanaddress/prepare", method: "POST", body: { function: "transfer", args: [ADDR, "1"], from: ADDR } },
      { path: "/v1/notachain/name/by-address/notanaddress" },
    ];

    for (const testCase of cases) {
      const res = await app.request(testCase.path, {
        method: testCase.method ?? "GET",
        ...(testCase.body
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(testCase.body),
            }
          : {}),
      });
      expect(res.status, testCase.path).toBe(400);
      expect(await res.json(), testCase.path).toEqual({
        error: {
          code: "INVALID_ADDRESS",
          message: 'Not a valid address: "notanaddress"',
        },
      });
    }
  });

  it("invalid include_abi query → 400 INVALID_ARGS before resolving", async () => {
    const res = await app.request(`/v1/ethereum/${ADDR}/abi?include_abi=maybe`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ARGS");
  });

  it("invalid method filter query → 400 INVALID_ARGS before resolving", async () => {
    const res = await app.request(`/v1/ethereum/${ADDR}/abi?method_limit=-1`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ARGS");
  });

  it("unknown chain → 400 UNKNOWN_CHAIN", async () => {
    const res = await app.request(`/v1/notachain/${ADDR}/abi`);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("UNKNOWN_CHAIN");
  });

  it("invalid rpc_url override → 400 INVALID_ARGS", async () => {
    const res = await app.request(`/v1/ethereum/${ADDR}/abi?rpc_url=not-a-url`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "INVALID_ARGS",
        message: "`rpc_url` must be an http(s) URL.",
      },
    });
  });

  it("rpc_url override with whitespace → 400 INVALID_ARGS", async () => {
    const res = await app.request(`/v1/ethereum/${ADDR}/abi?rpc_url=${encodeURIComponent("https://rpc.example/a b")}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "INVALID_ARGS",
        message: "`rpc_url` must be an http(s) URL.",
      },
    });
  });

  it("invalid tx hash → 400 INVALID_ADDRESS", async () => {
    const res = await app.request("/v1/ethereum/tx/0xnotahash");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ADDRESS");
  });

  it("unknown route → 404", async () => {
    expect((await app.request("/nope")).status).toBe(404);
  });

  it("malformed JSON bodies on POST verbs → 400 INVALID_ARGS envelope", async () => {
    for (const path of [
      `/v1/ethereum/${ADDR}/read`,
      `/v1/ethereum/${ADDR}/encode`,
      "/v1/ethereum/simulate",
      `/v1/ethereum/${ADDR}/prepare`,
    ]) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      expect(res.status, path).toBe(400);
      expect(await res.json(), path).toEqual({
        error: {
          code: "INVALID_ARGS",
          message: "Request body must be valid JSON.",
        },
      });
    }
  });

  it("invalid POST body fields are rejected before chain resolution", async () => {
    const cases: Array<{ path: string; body: unknown; message: string }> = [
      { path: `/v1/notachain/${ADDR}/read`, body: { args: [] }, message: "`function` must be a non-empty string." },
      { path: `/v1/notachain/${ADDR}/encode`, body: { function: "balanceOf", args: "bad" }, message: "`args` must be an array." },
      { path: `/v1/notachain/${ADDR}/encode`, body: { function: "approve", args: [], value: "1.5" }, message: "`value` must be a decimal string in wei." },
      { path: "/v1/notachain/simulate", body: { from: ADDR, to: ADDR, data: "0x0" }, message: "`data` must be 0x-prefixed hex bytes." },
      { path: "/v1/notachain/simulate", body: { from: ADDR, to: ADDR, data: "0x", address: ADDR, function: "transfer", args: [] }, message: "simulate accepts either raw {to,data} or high-level {address,function,args}, not both." },
      { path: "/v1/notachain/simulate", body: { from: ADDR, address: ADDR }, message: "`function` must be a non-empty string." },
      { path: `/v1/notachain/${ADDR}/prepare`, body: { function: "approve", args: [], from: ADDR, value: "abc" }, message: "`value` must be a decimal string in wei." },
    ];

    for (const testCase of cases) {
      const res = await app.request(testCase.path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(testCase.body),
      });
      expect(res.status, testCase.path).toBe(400);
      expect(await res.json(), testCase.path).toEqual({
        error: {
          code: "INVALID_ARGS",
          message: testCase.message,
        },
      });
    }
  });

  it("non-object JSON bodies on POST verbs → 400 INVALID_ARGS envelope", async () => {
    const res = await app.request(`/v1/notachain/${ADDR}/read`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "[]",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        code: "INVALID_ARGS",
        message: "Request body must be a JSON object.",
      },
    });
  });

  it("GET /v1/lookup/:selector — malformed selector → 400 INVALID_ARGS", async () => {
    const res = await app.request("/v1/lookup/0x123");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ARGS");
  });

  it("GET /v1/lookup/:selector — unknown selector → 200 with empty entries", async () => {
    const res = await app.request("/v1/lookup/0x00000000");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    expect(await res.json()).toEqual({ selector: "0x00000000", entries: [] });
  });

  it("GET /v1/lookup/:selector — returns seeded registry entries (incl. 32-byte event topics)", async () => {
    const { registry } = await import("../src/registry/store.js");
    registry.recordProven({ selector: "0x70a08231", kind: "function", signature: "balanceOf(address)" });
    registry.recordVerifiedAbi(1, ADDR, [{
      type: "function",
      name: "totalSupply",
      stateMutability: "view",
      inputs: [],
      outputs: [{ name: "supply", type: "uint256" }],
    }] as any);
    const res = await app.request("/v1/lookup/0x70A08231"); // case-insensitive
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.entries).toContainEqual({ kind: "function", signature: "balanceOf(address)", proof: "keccak-proven" });

    const verifiedSelector = toFunctionSelector("totalSupply()");
    const verified = await app.request(`/v1/lookup/${verifiedSelector}`);
    expect(verified.status).toBe(200);
    expect((await verified.json()).entries).toContainEqual(expect.objectContaining({
      kind: "function",
      signature: "totalSupply()",
      proof: "verified-source",
      chain: 1,
      address: ADDR,
      abi_item: expect.objectContaining({ name: "totalSupply" }),
    }));
  });

  it("GET /v1/registry/export → JSONL with seeded entries", async () => {
    const { registry } = await import("../src/registry/store.js");
    const signature = "exportMe(uint256)";
    const selector = toFunctionSelector(signature);
    registry.recordProven({ selector, kind: "function", signature });
    const res = await app.request("/v1/registry/export");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("ndjson");
    expect(res.headers.get("cache-control")).toContain("max-age=300");
    expect(res.headers.get("x-license")).toBe("CC0-1.0");
    expect(res.headers.get("link")).toContain("creativecommons.org/publicdomain/zero/1.0");
    expect(res.headers.get("content-disposition")).toContain("evm-abi-commons.selectors.ndjson");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toContainEqual(expect.objectContaining({ selector, signature, proof: "keccak-proven" }));

    registry.recordVerifiedAbi(1, ADDR, [{
      type: "function",
      name: "balanceOf",
      stateMutability: "view",
      inputs: [{ name: "owner", type: "address" }],
      outputs: [{ name: "balance", type: "uint256" }],
    }] as any);
    const withSource = (await (await app.request("/v1/registry/export")).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(withSource).toContainEqual(expect.objectContaining({
      selector: "0x70a08231",
      signature: "balanceOf(address)",
      proof: "verified-source",
      chain: 1,
      address: ADDR,
    }));
  });

  it("GET /v1/registry/stats → 200 with counts", async () => {
    const res = await app.request("/v1/registry/stats");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=60");
    const body = await res.json();
    expect(body).toHaveProperty("selectors");
    expect(body).toHaveProperty("bytecodes");
  });

  it("GET /v1/chains → viem-backed chain catalog", async () => {
    const res = await app.request("/v1/chains");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=3600");
    const body = await res.json();
    expect(body.chains.length).toBeGreaterThan(100);
    expect(body.chains).toContainEqual(expect.objectContaining({
      id: 143,
      name: "Monad",
      aliases: expect.arrayContaining(["monad", "monad-mainnet"]),
      testnet: false,
      has_default_rpc: true,
      default_rpc_url: "https://rpc.monad.xyz",
    }));
  });

  it("GET /v1/chains filters by query, testnets, and default RPC", async () => {
    const res = await app.request("/v1/chains?q=monad&testnets=false&has_default_rpc=true");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chains).toContainEqual(expect.objectContaining({ id: 143, name: "Monad" }));
    expect(body.chains).not.toContainEqual(expect.objectContaining({ id: 10143 }));

    const multiToken = await app.request("/v1/chains?q=bnb%20chain&has_default_rpc=true");
    expect(multiToken.status).toBe(200);
    await expect(multiToken.json()).resolves.toMatchObject({
      chains: expect.arrayContaining([expect.objectContaining({ id: 56, name: "BNB Smart Chain" })]),
    });
  });

  it("GET /v1/chains rejects invalid boolean filters", async () => {
    const res = await app.request("/v1/chains?testnets=maybe");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ARGS");
  });

  it("sets provenance-aware Cache-Control for ABI responses", () => {
    expect(cacheControlForAbi({
      provenance: { confidence: "verified" },
    } as any)).toContain("max-age=86400");
    expect(cacheControlForAbi({
      provenance: { confidence: "partial" },
    } as any)).toContain("max-age=3600");
    expect(cacheControlForAbi({
      provenance: { confidence: "decompiled" },
    } as any)).toContain("max-age=3600");
    expect(cacheControlForAbi({
      proxy: { is_proxy: true },
      provenance: { confidence: "verified" },
    } as any)).toContain("max-age=300");
  });

  it("sets rate-limit headers on API routes", async () => {
    const res = await app.request("/v1/ethereum/notanaddress/abi");
    expect(res.headers.get("ratelimit-limit")).toBe("120");
    expect(res.headers.get("ratelimit-remaining")).not.toBeNull();
  });

  it("sets CORS allow-origin", async () => {
    const res = await app.request("/health", { headers: { origin: "https://abi.ninja" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
