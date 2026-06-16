import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { AGENT_VERBS, MCP_TOOLS } from "../src/agentSurface.js";
import { llmsTxt } from "../src/llms.js";
import { createMcpServer } from "../src/mcp-server.js";
import { openApiSpec } from "../src/openapi.js";
import { app } from "../src/server.js";

const sortedVerbs = [...AGENT_VERBS].sort();
const sortedMcpTools = [...MCP_TOOLS].sort();

describe("agent surface parity", () => {
  it("keeps REST discovery on the canonical seven verbs and MCP on verbs plus utilities", async () => {
    const root = await (await app.request("/")).json();
    expect([...root.verbs].sort()).toEqual(sortedVerbs);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "surface-parity", version: "0.0.0" });
    const server = createMcpServer();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual(sortedMcpTools);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps docs, Skill reference, llms.txt, and OpenAPI advertising the same verbs", async () => {
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    const spec = await readFile(join(process.cwd(), "SPEC.md"), "utf8");
    const skill = await readFile(join(process.cwd(), "skill/gulltoppr/reference.md"), "utf8");
    const site = await readFile(join(process.cwd(), "docs/index.html"), "utf8");

    for (const verb of AGENT_VERBS) {
      expect(readme).toContain(verb);
      expect(skill).toContain(`\`${verb}\``);
      expect(site).toContain(verb);
      expect(llmsTxt).toContain(verb);
    }
    expect(spec).toContain("same verbs to MCP tools plus read-only");
    expect(spec).not.toContain("(future) MCP server");
    expect(spec).toContain("| discovery | `GET /`");
    expect(spec).toContain("core verbs, utility tools, and the `prepare_tx` safety gate");
    expect(spec).toContain("| agent guide | `GET /llms.txt`");
    expect(spec).toContain("| selector lookup | `GET /v1/lookup/{selector}`");
    expect(spec).toContain("| registry export | `GET /v1/registry/export`");
    expect(spec).toContain("| runtime metrics | `GET /v1/metrics`");
    expect(spec).toContain("| `list_chains` | §4/§6 |");
    expect(spec).toContain("| `runtime_metrics` | §4 |");
    expect(spec).toContain("JSON MCP tools expose `outputSchema` and `structuredContent`");
    expect(spec).toContain("intentional exception because it returns bulk CC0 NDJSON");
    expect(spec).toContain("For JSON MCP tools, MCP exposes the returned REST object as `structuredContent`");
    expect(spec).toContain("leads with a `WARNING` before the JSON");
    expect(readme).toContain("partial/proxy/bytecode-match/decompiled ABI results");
    expect(spec).toContain("`rung.etherscan`, `rung.sourcify`, `rung.proxy_detection`");
    expect(spec).toContain("`rung.heimdall`, `rung.4byte`, and public fallback lookups");
    expect(llmsTxt).toContain("Resolver ladder buckets: rung.etherscan, rung.sourcify, rung.proxy_detection");
    expect(llmsTxt).toContain("rung.4byte.directory");
    expect(spec).toContain("aliases, testnet, has_default_rpc, default_rpc_url?");
    expect(spec).toContain("multi-word");
    expect(readme).toContain("multi-word searches such as `bnb chain`");
    expect(readme).toContain("never mix both forms");
    expect(spec).toContain("mixed forms are rejected");
    expect(spec).toContain("accepts only entries whose canonical signature");
    expect(spec).toContain("fallback labels, never proof");
    expect(spec).toContain("`provenance.bytecode_match`");
    expect(readme).toContain("`provenance.bytecode_match` points at the original chain/address/source/confidence");
    expect(skill).toContain("`provenance.bytecode_match?`");
    expect(llmsTxt).toContain("provenance.bytecode_match");
    expect(spec).toContain("rejects view/pure fns with `NOT_A_WRITE_FN`");
    expect(spec).toContain("`X-Elapsed-Ms`");
    expect(spec).toContain("`X-ABI-Included`");
    expect(spec).toContain("`RateLimit-Limit`, `RateLimit-Remaining`, and");
    expect(readme).toContain("`X-ABI-Included`");
    expect(readme).toContain("`Retry-After` on 429 responses");

    expect(Object.keys(openApiSpec.paths).sort()).toEqual([
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
    expect(openApiSpec.paths["/"].get.responses["200"].content["application/json"].schema).toEqual({
      $ref: "#/components/schemas/Discovery",
    });
  });

  it("keeps the write safety hand-off rule visible across agent-facing surfaces", async () => {
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    const skill = await readFile(join(process.cwd(), "skill/gulltoppr/SKILL.md"), "utf8");
    const reference = await readFile(join(process.cwd(), "skill/gulltoppr/reference.md"), "utf8");
    const integrations = await readFile(join(process.cwd(), "docs/integrations.md"), "utf8");
    const spec = await readFile(join(process.cwd(), "SPEC.md"), "utf8");
    const prepare = openApiSpec.paths["/v1/{chain}/{address}/prepare"].post;
    const resolve = openApiSpec.paths["/v1/{chain}/{address}/abi"].get;
    const chains = openApiSpec.paths["/v1/chains"].get;

    for (const text of [readme, skill, reference, integrations, llmsTxt, spec, prepare.description]) {
      expect(text).toContain("safety.signing_recommended");
      expect(text).toContain("wallet_request");
    }
    expect(skill).toContain("configured signing deeplink");
    expect(prepare.description).toContain("signing_recommended");
    expect(spec).toContain("`SIGNING_BASE_URL` controls the optional shareable signing deeplink");
    expect(llmsTxt).toContain("spending_approval");
    expect(llmsTxt).toContain("asset_outflow");
    expect(llmsTxt).toContain("simulation_failed");
    expect(spec).toContain('safety.risk_level: "blocked"');
    expect(spec).toContain("never returns an unsimulated signing hand-off");
    expect(prepare.description).toContain("Never signs or broadcasts");
    expect(resolve.parameters).toContainEqual(expect.objectContaining({ name: "include_abi" }));
    expect(chains.parameters.find((p: any) => p.name === "q")?.description).toContain("multi-word");
  });
});
