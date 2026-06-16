import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer, MCP_SERVER_VERSION } from "../src/mcp-server.js";
import { createMcpHttpServer } from "../src/mcp-http-server.js";
import { MCP_TOOLS } from "../src/agentSurface.js";

describe("MCP server", () => {
  const expectedTools = [...MCP_TOOLS].sort();
  const address = "0x0000000000000000000000000000000000000001";

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function callTool(name: string, args: Record<string, unknown>) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `gulltoppr-${name}-test`, version: "0.0.0" });
    const server = createMcpServer();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return await client.callTool({ name, arguments: args });
    } finally {
      await client.close();
      await server.close();
    }
  }

  function toolText(result: Awaited<ReturnType<typeof callTool>>): string {
    return result.content[0].type === "text" ? result.content[0].text : "";
  }

  it("initializes and exposes the agent verbs plus read-only utility tools with safe write guidance", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "gulltoppr-test", version: "0.0.0" });
    const server = createMcpServer();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect(client.getServerVersion()).toMatchObject({
        name: "gulltoppr",
        version: MCP_SERVER_VERSION,
      });

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(expectedTools);

      const prepare = tools.find((tool) => tool.name === "prepare_tx");
      expect(prepare?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
      });
      expect(prepare?.description).toContain("safety.signing_recommended");
      expect(prepare?.description).toContain("NEVER signs or broadcasts");
      expect(prepare?.description).toContain("configured signing deeplink");
      expect(prepare?.description).not.toContain("abi.ninja signing deeplink");
      const prepareOutputSchema = prepare?.outputSchema as any;
      expect(prepareOutputSchema.required).toEqual(expect.arrayContaining(["unsigned_tx", "simulation", "human_summary", "warnings", "safety"]));
      expect(prepareOutputSchema.properties.safety.properties.risk_level.enum).toEqual(["low", "medium", "high", "blocked"]);
      expect(prepareOutputSchema.properties.safety.properties.reasons.items.enum).toContain("spending_approval");
      expect(tools.find((tool) => tool.name === "resolve_abi")?.description).toContain("Raw ABI is omitted");
      expect(tools.find((tool) => tool.name === "resolve_abi")?.description).toContain("method_q");
      expect(tools.find((tool) => tool.name === "resolve_abi")?.description).toContain("bytecode-match results lead with a WARNING");
      expect(tools.find((tool) => tool.name === "resolve_abi")?.description).toContain("structuredContent");
      const listChainsSchema = tools.find((tool) => tool.name === "list_chains")?.inputSchema as any;
      expect(listChainsSchema.properties.q.description).toContain("multi-word");
      expect(listChainsSchema.properties.q.description).toContain("native symbol");
      const listChainsOutputSchema = tools.find((tool) => tool.name === "list_chains")?.outputSchema as any;
      expect(listChainsOutputSchema.required).toEqual(["chains"]);
      expect(listChainsOutputSchema.properties.chains.items.required).toEqual(expect.arrayContaining(["id", "name", "aliases", "testnet", "has_default_rpc", "native_currency"]));
      expect(listChainsOutputSchema.properties.chains.items.properties.native_currency.properties.decimals.type).toBe("integer");

      const prepareSchema = prepare?.inputSchema as any;
      expect(prepareSchema.properties.address.pattern).toBe("^0x[0-9a-fA-F]{40}$");
      expect(prepareSchema.properties.from.pattern).toBe("^0x[0-9a-fA-F]{40}$");
      expect(prepareSchema.properties.function).toMatchObject({ minLength: 1, pattern: "\\S" });
      expect(prepareSchema.properties.value.pattern).toBe("^\\d+$");
      expect(prepareSchema.properties.rpc_url.pattern).toBe("^https?:\\/\\/\\S+$");

      const simulateSchema = tools.find((tool) => tool.name === "simulate")?.inputSchema as any;
      expect(tools.find((tool) => tool.name === "simulate")?.description).toContain("never both");
      expect(simulateSchema.properties.data.pattern).toBe("^0x([0-9a-fA-F]{2})*$");
      expect(simulateSchema.properties.to).toMatchObject({ $ref: "#/properties/address" });
      const simulateOutputSchema = tools.find((tool) => tool.name === "simulate")?.outputSchema as any;
      expect(simulateOutputSchema.required).toEqual(expect.arrayContaining(["success", "gas_used", "state_diff", "asset_changes", "logs"]));
      expect(simulateOutputSchema.properties.return_value.properties.raw.pattern).toBe("^0x([0-9a-fA-F]{2})*$");
      expect(simulateOutputSchema.properties.asset_changes.items.properties.kind.enum).toEqual(["erc20", "erc721", "erc1155", "native"]);

      const decodeSchema = tools.find((tool) => tool.name === "decode_tx")?.inputSchema as any;
      expect(decodeSchema.properties.tx_hash.pattern).toBe("^0x[0-9a-fA-F]{64}$");
      const decodeOutputSchema = tools.find((tool) => tool.name === "decode_tx")?.outputSchema as any;
      expect(decodeOutputSchema.required).toEqual(expect.arrayContaining(["chain", "tx_hash", "source", "cached", "decoded", "provenance"]));
      expect(decodeOutputSchema.properties.tx_hash.pattern).toBe("^0x[0-9a-fA-F]{64}$");
      expect(decodeOutputSchema.properties.decoded_call.anyOf[0].properties.args.items.properties.value).toMatchObject({});

      const lookupSchema = tools.find((tool) => tool.name === "lookup_selector")?.inputSchema as any;
      expect(lookupSchema.properties.selector.pattern).toBe("^0x([0-9a-fA-F]{8}|[0-9a-fA-F]{64})$");
      const lookupOutputSchema = tools.find((tool) => tool.name === "lookup_selector")?.outputSchema as any;
      expect(lookupOutputSchema.required).toEqual(["selector", "entries"]);
      expect(lookupOutputSchema.properties.entries.items.properties.proof.enum).toEqual(["verified-source", "keccak-proven"]);

      const metricsOutputSchema = tools.find((tool) => tool.name === "runtime_metrics")?.outputSchema as any;
      expect(metricsOutputSchema.required).toEqual(["uptime_seconds", "metrics"]);
      expect(metricsOutputSchema.properties.metrics.additionalProperties.properties.failure_rate.maximum).toBe(1);

      const statsOutputSchema = tools.find((tool) => tool.name === "registry_stats")?.outputSchema as any;
      expect(statsOutputSchema.required).toEqual(["selectors", "bytecodes"]);
      expect(statsOutputSchema.properties.selectors.additionalProperties.type).toBe("integer");

      const resolveSchema = tools.find((tool) => tool.name === "resolve_abi")?.inputSchema as any;
      expect(resolveSchema.properties.method_kind.enum).toEqual(["read", "write", "all"]);
      expect(resolveSchema.properties.method_limit.minimum).toBe(0);
      expect(resolveSchema.properties.method_limit.maximum).toBe(500);
      const resolveOutputSchema = tools.find((tool) => tool.name === "resolve_abi")?.outputSchema as any;
      expect(resolveOutputSchema.required).toEqual(expect.arrayContaining(["chain", "address", "interface", "provenance", "abi_for", "cached", "abi_omitted"]));
      expect(resolveOutputSchema.properties.provenance.properties.confidence.enum).toEqual(["verified", "partial", "decompiled", "selector-only"]);
      expect(resolveOutputSchema.properties.provenance.properties.bytecode_match.properties.address).toEqual({ $ref: "#/properties/address" });
      expect(resolveOutputSchema.properties.interface.properties.reads.items.properties.inputs.items.properties.type.type).toBe("string");
      expect(resolveOutputSchema.properties.interface.properties.reads.items.properties.outputs.items).toEqual({
        $ref: "#/properties/interface/properties/reads/items/properties/inputs/items",
      });
      expect(resolveOutputSchema.properties.abi_omitted.const).toBe(true);

      const readOutputSchema = tools.find((tool) => tool.name === "read_contract")?.outputSchema as any;
      expect(readOutputSchema.required).toEqual(["decoded", "raw", "function_signature"]);
      expect(readOutputSchema.properties.raw.pattern).toBe("^0x([0-9a-fA-F]{2})*$");
      const encodeOutputSchema = tools.find((tool) => tool.name === "encode_call")?.outputSchema as any;
      expect(encodeOutputSchema.required).toEqual(["data", "function_signature"]);
      expect(encodeOutputSchema.properties.data.pattern).toBe("^0x([0-9a-fA-F]{2})*$");
      const nameOutputSchema = tools.find((tool) => tool.name === "resolve_name")?.outputSchema as any;
      expect(nameOutputSchema.properties.address.pattern).toBe("^0x[0-9a-fA-F]{40}$");

      for (const tool of tools.filter((t) => t.name !== "prepare_tx")) {
        expect(tool.annotations).toMatchObject({ readOnlyHint: true });
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("serves the same tools over local Streamable HTTP", async () => {
    const httpServer = createMcpHttpServer();
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const { port } = httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;
    const client = new Client({ name: "gulltoppr-http-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));

    try {
      const health = await fetch(`${baseUrl}/health`);
      expect(health.status).toBe(200);
      expect(health.headers.get("access-control-allow-origin")).toBe("*");
      expect(await health.json()).toMatchObject({ ok: true, endpoint: "/mcp" });

      const checkedInMetadata = JSON.parse(await readFile(join(process.cwd(), "server.json"), "utf8"));
      for (const path of ["/server.json", "/.well-known/mcp-server.json"]) {
        const metadata = await fetch(`${baseUrl}${path}`);
        expect(metadata.status, path).toBe(200);
        expect(metadata.headers.get("access-control-allow-origin"), path).toBe("*");
        expect(metadata.headers.get("content-type"), path).toContain("application/json");
        expect(metadata.headers.get("cache-control"), path).toContain("max-age=300");
        expect(await metadata.json(), path).toEqual(checkedInMetadata);
      }

      const badRpc = await fetch(`${baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://agent.example" },
        body: "{",
      });
      expect(badRpc.status).toBe(400);
      expect(badRpc.headers.get("access-control-allow-origin")).toBe("*");
      expect(badRpc.headers.get("access-control-expose-headers")).toContain("mcp-session-id");
      expect(badRpc.headers.get("ratelimit-limit")).not.toBeNull();
      expect(await badRpc.json()).toMatchObject({
        jsonrpc: "2.0",
        error: { code: -32700, message: "Parse error" },
      });

      await client.connect(transport);
      expect(client.getServerVersion()).toMatchObject({
        name: "gulltoppr",
        version: MCP_SERVER_VERSION,
      });
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(expectedTools);
    } finally {
      await client.close().catch(() => {});
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  it("resolve_abi requests compact REST output and does not expose raw ABI to the model", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string) => {
        calls.push(String(url));
        return new Response(
          JSON.stringify({
            chain: 8453,
            address: "0x0000000000000000000000000000000000000001",
            interface: { reads: [], writes: [] },
            provenance: {
              source: "etherscan",
              confidence: "verified",
              verified: true,
              names_synthetic: false,
              natspec: true,
            },
            abi_for: "0x0000000000000000000000000000000000000001",
            cached: false,
            abi_omitted: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const result = await callTool("resolve_abi", {
      chain: "base",
      address: "0x0000000000000000000000000000000000000001",
      rpc_url: "http://127.0.0.1:8545",
      method_q: "transfer",
      method_kind: "write",
      method_limit: 1,
    });
    const text = toolText(result);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/v1/base/0x0000000000000000000000000000000000000001/abi");
    expect(calls[0]).toContain("include_abi=false");
    expect(calls[0]).toContain("method_q=transfer");
    expect(calls[0]).toContain("method_kind=write");
    expect(calls[0]).toContain("method_limit=1");
    expect(calls[0]).toContain("rpc_url=http%3A%2F%2F127.0.0.1%3A8545");
    expect(result.structuredContent).toMatchObject({
      chain: 8453,
      address,
      interface: { reads: [], writes: [] },
      provenance: { source: "etherscan", confidence: "verified", verified: true },
      abi_for: address,
      cached: false,
      abi_omitted: true,
    });
    expect(text).toContain('"abi_omitted": true');
    expect(text).not.toContain('"abi":');
  });

  it("resolve_abi leads with provenance warnings for partial bytecode-match proxy results", async () => {
    const original = "0x00000000000000000000000000000000000000A1";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            chain: 8453,
            address,
            interface: { reads: [], writes: [] },
            provenance: {
              source: "bytecode-match",
              confidence: "partial",
              verified: false,
              names_synthetic: false,
              natspec: false,
              bytecode_match: {
                chain: 1,
                address: original,
                source: "etherscan",
                confidence: "verified",
              },
            },
            proxy: {
              is_proxy: true,
              pattern: "eip1967",
              hops: [{ address, role: "proxy" }, { address, role: "implementation" }],
              resolved_implementation: address,
            },
            abi_for: address,
            cached: true,
            abi_omitted: true,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const result = await callTool("resolve_abi", { chain: "base", address });
    const text = toolText(result);

    expect(text.startsWith("WARNING ")).toBe(true);
    expect(text).toContain("partial provenance");
    expect(text).toContain(`bytecode match: ABI reused from ${original} on chain 1`);
    expect(text).toContain("eip1967 proxy");
    expect(text).toContain('"source": "bytecode-match"');
    expect(result.structuredContent).toMatchObject({
      provenance: {
        source: "bytecode-match",
        confidence: "partial",
        bytecode_match: {
          chain: 1,
          address: original,
          source: "etherscan",
          confidence: "verified",
        },
      },
      proxy: {
        is_proxy: true,
        pattern: "eip1967",
      },
      abi_omitted: true,
    });
  });

  it("resolve_abi returns a typed MCP error when the engine cannot be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket closed");
      }),
    );

    const result = await callTool("resolve_abi", {
      chain: "base",
      address: "0x0000000000000000000000000000000000000001",
    });

    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain('"code": "NETWORK"');
    expect(toolText(result)).toContain("Failed to reach gulltoppr engine: socket closed");
  });

  it("resolve_abi returns a typed MCP error when the compact engine response is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not json", { status: 200, headers: { "content-type": "text/plain" } })),
    );

    const result = await callTool("resolve_abi", {
      chain: "base",
      address: "0x0000000000000000000000000000000000000001",
    });

    expect(result.isError).toBe(true);
    expect(toolText(result)).toContain('"code": "INTERNAL"');
    expect(toolText(result)).toContain("gulltoppr engine returned invalid JSON");
  });

  it("forwards MCP verbs directly to the REST engine with validated payloads", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? "GET",
          url: String(url),
          ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
        });

        const pathname = new URL(String(url)).pathname;
        if (pathname === "/v1/registry/export") {
          return new Response('{"selector":"0xa9059cbb","kind":"function","signature":"transfer(address,uint256)"}\n', {
            status: 200,
            headers: { "content-type": "application/x-ndjson" },
          });
        }
        const body =
          pathname === "/v1/chains" ? { chains: [{ id: 8453, name: "Base", aliases: ["base"], testnet: false, has_default_rpc: true, native_currency: { name: "Ether", symbol: "ETH", decimals: 18 } }] }
          : pathname === "/v1/metrics" ? {
              uptime_seconds: 1,
              metrics: {
                "rung.etherscan": {
                  attempts: 1,
                  successes: 1,
                  misses: 0,
                  failures: 0,
                  total_latency_ms: 5,
                  avg_latency_ms: 5,
                  max_latency_ms: 5,
                  failure_rate: 0,
                },
              },
            }
          : pathname === "/v1/lookup/0xa9059cbb" ? { selector: "0xa9059cbb", entries: [] }
          : pathname === "/v1/registry/stats" ? { selectors: { "function:verified-source": 1 }, bytecodes: 0 }
          : pathname.endsWith("/read") ? { decoded: ["1"], raw: "0x", function_signature: "balanceOf(address)" }
          : pathname.endsWith("/encode") ? { data: "0x1234", function_signature: "transfer(address,uint256)" }
          : pathname.endsWith("/simulate") ? { success: true, gas_used: 21000, state_diff: [], asset_changes: [], logs: [] }
          : pathname.endsWith("/prepare") ? {
              unsigned_tx: { chainId: 8453, to: address, from: address, data: "0x1234", value: "0" },
              simulation: { success: true, gas_used: 21000, state_diff: [], asset_changes: [], logs: [] },
              human_summary: "Call transfer(address,uint256).",
              deeplink: "https://abi.ninja/8453/0x0000000000000000000000000000000000000001",
              wallet_request: {
                chainId: 8453,
                method: "eth_sendTransaction",
                params: [{ from: address, to: address, data: "0x1234", value: "0x0" }],
              },
              warnings: [],
              safety: { signing_recommended: true, risk_level: "low", requires_human_confirmation: false, reasons: [] },
            }
          : pathname.includes("/tx/") ? {
              chain: 8453,
              tx_hash: pathname.split("/").at(-1),
              source: "heimdall",
              cached: false,
              decoded: { summary: "transfer" },
              provenance: { source: "heimdall", confidence: "decompiled", verified: false, names_synthetic: true },
              decoded_call: null,
            }
          : pathname.includes("/name/") ? { name: "vitalik.eth", address }
          : { ok: true };

        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    const txHash = "0x000000000000000000000000000000000000000000000000000000000000dead";

    const chains = await callTool("list_chains", { q: "base", testnets: false, has_default_rpc: true });
    const metrics = await callTool("runtime_metrics", {});
    const lookup = await callTool("lookup_selector", { selector: "0xA9059CBB" });
    const stats = await callTool("registry_stats", {});
    const exported = await callTool("export_registry", {});
    expect(toolText(exported)).toContain('"selector":"0xa9059cbb"');
    const read = await callTool("read_contract", { chain: "base", address, function: "balanceOf", args: [address], rpc_url: "http://127.0.0.1:8545" });
    const encoded = await callTool("encode_call", { chain: "base", address, function: "transfer", args: [address, "1"], value: "0" });
    const simulated = await callTool("simulate", { chain: "base", from: address, address, function: "transfer", args: [address, "1"] });
    await callTool("prepare_tx", { chain: "base", address, function: "transfer", args: [address, "1"], from: address });
    const decoded = await callTool("decode_tx", { chain: "base", tx_hash: txHash });
    const resolvedName = await callTool("resolve_name", { chain: "ethereum", name: "vitalik.eth" });

    expect(read.structuredContent).toMatchObject({ decoded: ["1"], raw: "0x", function_signature: "balanceOf(address)" });
    expect(encoded.structuredContent).toMatchObject({ data: "0x1234", function_signature: "transfer(address,uint256)" });
    expect(simulated.structuredContent).toMatchObject({ success: true, gas_used: 21000, state_diff: [], asset_changes: [], logs: [] });
    expect(chains.structuredContent).toMatchObject({ chains: [{ id: 8453, name: "Base", aliases: ["base"], testnet: false, has_default_rpc: true }] });
    expect(metrics.structuredContent).toMatchObject({ uptime_seconds: 1, metrics: { "rung.etherscan": { attempts: 1, failure_rate: 0 } } });
    expect(lookup.structuredContent).toMatchObject({ selector: "0xa9059cbb", entries: [] });
    expect(stats.structuredContent).toMatchObject({ selectors: { "function:verified-source": 1 }, bytecodes: 0 });
    expect(decoded.structuredContent).toMatchObject({
      chain: 8453,
      tx_hash: txHash,
      source: "heimdall",
      cached: false,
      provenance: { confidence: "decompiled", verified: false, names_synthetic: true },
      decoded_call: null,
    });
    expect(resolvedName.structuredContent).toMatchObject({ name: "vitalik.eth", address });

    expect(calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)).toEqual([
      "GET /v1/chains",
      "GET /v1/metrics",
      "GET /v1/lookup/0xa9059cbb",
      "GET /v1/registry/stats",
      "GET /v1/registry/export",
      `POST /v1/base/${address}/read`,
      `POST /v1/base/${address}/encode`,
      "POST /v1/base/simulate",
      `POST /v1/base/${address}/prepare`,
      `GET /v1/base/tx/${txHash}`,
      "GET /v1/ethereum/name/vitalik.eth",
    ]);
    const chainsUrl = new URL(calls[0].url);
    expect(chainsUrl.searchParams.get("q")).toBe("base");
    expect(chainsUrl.searchParams.get("testnets")).toBe("false");
    expect(chainsUrl.searchParams.get("has_default_rpc")).toBe("true");
    expect(new URL(calls[5].url).searchParams.get("rpc_url")).toBe("http://127.0.0.1:8545");
    expect(calls[5].body).toEqual({ function: "balanceOf", args: [address] });
    expect(calls[6].body).toEqual({ function: "transfer", args: [address, "1"], value: "0" });
    expect(calls[7].body).toEqual({ from: address, address, function: "transfer", args: [address, "1"] });
    expect(calls[8].body).toEqual({ function: "transfer", args: [address, "1"], from: address });
    expect(calls[9].body).toBeUndefined();
    expect(calls[10].body).toBeUndefined();
  });

  it("accepts numeric chain ids through MCP tools", async () => {
    const calls: Array<{ method: string; url: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string, init?: RequestInit) => {
        calls.push({
          method: init?.method ?? "GET",
          url: String(url),
          ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as unknown } : {}),
        });
        return new Response(JSON.stringify({ decoded: ["1"], raw: "0x", function_signature: "balanceOf(address)" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const result = await callTool("read_contract", {
      chain: 8453,
      address,
      function: "balanceOf",
      args: [address],
      rpc_url: "http://127.0.0.1:8545",
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ decoded: ["1"], raw: "0x", function_signature: "balanceOf(address)" });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(new URL(calls[0].url).pathname).toBe(`/v1/8453/${address}/read`);
    expect(new URL(calls[0].url).searchParams.get("rpc_url")).toBe("http://127.0.0.1:8545");
    expect(calls[0].body).toEqual({ function: "balanceOf", args: [address] });
  });

  it("prepare_tx leads with engine safety metadata even when warnings are empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: URL | string) => {
        const pathname = new URL(String(url)).pathname;
        const body = pathname.endsWith("/prepare")
          ? {
              unsigned_tx: { chainId: 8453, to: address, from: address, data: "0x1234", value: "0" },
              simulation: { success: true, gas_used: 21000, state_diff: [], asset_changes: [], logs: [] },
              human_summary: "Call transfer(address,uint256).",
              deeplink: "https://abi.ninja/8453/0x0000000000000000000000000000000000000001",
              wallet_request: {
                chainId: 8453,
                method: "eth_sendTransaction",
                params: [{ from: address, to: address, data: "0x1234", value: "0x0" }],
              },
              warnings: [],
              safety: {
                signing_recommended: true,
                risk_level: "high",
                requires_human_confirmation: true,
                reasons: ["abi_names_inferred"],
              },
            }
          : { ok: true };

        return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    const result = await callTool("prepare_tx", { chain: "base", address, function: "transfer", args: [address, "1"], from: address });
    const text = toolText(result);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      safety: {
        signing_recommended: true,
        risk_level: "high",
        requires_human_confirmation: true,
        reasons: ["abi_names_inferred"],
      },
      warnings: [],
      unsigned_tx: { chainId: 8453, to: address, from: address, data: "0x1234", value: "0" },
    });
    expect(text).toContain("WARNING risk=high; signing_recommended=true; requires_human_confirmation=true.");
    expect(text).toContain("reasons=abi_names_inferred");
    expect(text).toContain('"risk_level": "high"');
  });

  it("simulate rejects incomplete raw/high-level forms before forwarding", async () => {
    const mixed = await callTool("simulate", { chain: "base", from: address, to: address, data: "0x", address, function: "transfer", args: [] });
    expect(mixed.isError).toBe(true);
    expect(toolText(mixed)).toContain('"code": "INVALID_ARGS"');
    expect(toolText(mixed)).toContain("simulate accepts either raw {to,data} or high-level {address,function,args}, not both.");

    const missingBoth = await callTool("simulate", { chain: "base", from: address });
    expect(missingBoth.isError).toBe(true);
    expect(toolText(missingBoth)).toContain('"code": "INVALID_ARGS"');
    expect(toolText(missingBoth)).toContain("simulate needs either {to,data} or {address,function,args}");

    const missingData = await callTool("simulate", { chain: "base", from: address, to: address });
    expect(missingData.isError).toBe(true);
    expect(toolText(missingData)).toContain("simulate raw form requires both `to` and `data`");

    const missingFunction = await callTool("simulate", { chain: "base", from: address, address });
    expect(missingFunction.isError).toBe(true);
    expect(toolText(missingFunction)).toContain("simulate high-level form requires both `address` and `function`");
  });
});
