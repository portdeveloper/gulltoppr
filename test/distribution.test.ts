import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MCP_TOOLS } from "../src/agentSurface.js";
import { MCP_SERVER_METADATA } from "../src/mcp-metadata.js";
import { MCP_SERVER_VERSION } from "../src/mcp-server.js";
import { llmsTxt } from "../src/llms.js";

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(join(process.cwd(), path), "utf8")) as T;
}

describe("distribution metadata", () => {
  it("keeps MCP metadata on the current SDK version without bundling the SDK runtime", async () => {
    const root = await readJson<{ dependencies: Record<string, string> }>("package.json");
    const lock = await readJson<{ packages: Record<string, { version?: string }> }>("package-lock.json");
    const sdk = await readJson<{ version: string }>("sdk/package.json");
    const glama = await readJson<{ $schema: string; maintainers: string[] }>("glama.json");
    const mcpServer = await readFile(join(process.cwd(), "src/mcp-server.ts"), "utf8");
    const server = await readJson<{
      version: string;
      description: string;
      websiteUrl?: string;
      icons?: Array<{ src: string; mimeType?: string; sizes?: string[] }>;
      remotes: Array<{ type: string; url: string }>;
      repository?: { url: string; source: string };
    }>("server.json");

    expect(root.dependencies).not.toHaveProperty("gulltoppr");
    expect(lock.packages).not.toHaveProperty("node_modules/gulltoppr");
    expect(mcpServer).not.toContain('from "gulltoppr"');
    expect(server).toEqual(MCP_SERVER_METADATA);
    expect(server.version).toBe(sdk.version);
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(server.repository).toEqual({
      url: "https://github.com/portdeveloper/gulltoppr",
      source: "github",
    });
    expect(glama).toEqual({
      $schema: "https://glama.ai/mcp/schemas/server.json",
      maintainers: ["portdeveloper"],
    });
    expect(server.repository.url).toContain(`github.com/${glama.maintainers[0]}/`);
    expect(server.websiteUrl).toBe("https://gulltoppr.dev");
    expect(server.icons).toContainEqual({
      src: "https://gulltoppr.dev/logo-400.png",
      mimeType: "image/png",
      sizes: ["400x400"],
    });
    await expect(readFile(join(process.cwd(), "docs/logo-400.png"))).resolves.toBeInstanceOf(Buffer);
    expect(MCP_SERVER_VERSION).toBe(sdk.version);
    expect(server.remotes).toContainEqual({
      type: "streamable-http",
      url: "https://mcp.gulltoppr.dev/mcp",
    });
  });

  it("keeps MCP documentation and runtime banners aligned with the additive tool surface", async () => {
    const readme = await readFile(join(process.cwd(), "README.md"), "utf8");
    const stdio = await readFile(join(process.cwd(), "src/mcp.ts"), "utf8");
    const http = await readFile(join(process.cwd(), "src/mcp-http.ts"), "utf8");

    expect(MCP_TOOLS).toContain("resolve_abi");
    expect(MCP_TOOLS).toContain("lookup_selector");
    expect(readme).toContain("seven core verbs plus");
    expect(readme).toContain("JSON MCP tools expose output schemas and");
    expect(readme).toContain("Utility tools: `list_chains`");
    expect(readme).not.toContain("7 tools");
    expect(readme).not.toContain("all 7 tools");
    expect(stdio).toContain("MCP_TOOLS.length");
    expect(http).toContain("MCP_TOOLS.length");
    expect(stdio).not.toContain("(7 tools");
    expect(http).not.toContain("(7 tools");
  });

  it("keeps deployment metadata on public custom domains", async () => {
    const flyMcp = await readFile(join(process.cwd(), "fly.mcp.toml"), "utf8");
    expect(flyMcp).toContain('app = "gulltoppr-mcp"');
    expect(flyMcp).toContain('ENGINE_URL = "https://api.gulltoppr.dev"');
    expect(flyMcp).not.toContain("abi.ninja MCP");
  });

  it("publishes the same llms.txt through the API source and static docs site", async () => {
    await expect(readFile(join(process.cwd(), "docs/llms.txt"), "utf8")).resolves.toBe(llmsTxt);
  });

  it("publishes integration recipes for the main distribution targets", async () => {
    const guide = await readFile(join(process.cwd(), "docs/integrations.md"), "utf8");
    const site = await readFile(join(process.cwd(), "docs/index.html"), "utf8");
    const skillReadme = await readFile(join(process.cwd(), "skill/README.md"), "utf8");
    const skill = await readFile(join(process.cwd(), "skill/gulltoppr/SKILL.md"), "utf8");
    const reference = await readFile(join(process.cwd(), "skill/gulltoppr/reference.md"), "utf8");

    expect(site).toContain("integrations.md");
    expect(site).toContain("include_abi=false");
    expect(site).toContain('id="rpc-url"');
    expect(site).toContain("monad-testnet");
    expect(site).toContain("WETH (monad testnet)");
    expect(site).toContain('params.set("rpc_url", rpcUrl)');
    expect(site).toContain("/v1/chains?has_default_rpc=true");
    expect(site).not.toContain("/v1/chains?testnets=false&has_default_rpc=true");
    expect(site).toContain('chain.testnet ? ", testnet"');
    expect(site).toContain('params.set("method_q", opts.method_q)');
    expect(site).toContain('params.set("method_kind", opts.method_kind || "all")');
    expect(site).toContain('params.set("method_limit"');
    expect(site).toContain("methodBadges");
    expect(site).toContain("mini payable");
    expect(site).toContain("mini inferred");
    expect(site).toContain("fn-hint");
    expect(site).toContain("function resolveWarnings(data)");
    expect(site).toContain('detailsBlock(`Warnings (${warningItems.length})`');
    expect(site).toContain("Raw JSON ABI omitted for compact agent context");
    expect(site).toContain("Partial source/proxy match");
    expect(site).toContain("Diamond proxy: ABI is merged");
    expect(site).toContain("Bytecode match: ABI reused from");
    expect(site).toContain("<b>abi for</b>");
    expect(site).toContain("<b>raw ABI</b>");
    expect(site).toContain("<b>bytecode match</b>");
    expect(site).toContain('haystack.replace(/\\s+/g, "").includes(query.replace(/\\s+/g, ""))');
    expect(site).toContain('query.split(/\\s+/).every((token) => haystack.includes(token))');
    expect(llmsTxt).toContain("https://gulltoppr.dev/integrations.md");
    expect(llmsTxt).toContain("https://api.gulltoppr.dev/");
    expect(llmsTxt).toContain("lookup_selector");
    expect(llmsTxt).toContain("runtime_metrics");
    expect(llmsTxt).toContain("has_default_rpc");
    expect(llmsTxt).toContain("multi-word and whitespace-insensitive queries");
    expect(llmsTxt).toContain("method_q");
    expect(guide).toContain("wallet_request");
    expect(guide).toContain("requireLowRiskWalletRequest");
    expect(guide).toContain("searchContractMethods");
    expect(guide).toContain("prep.safety.signing_recommended === true");
    expect(guide).toContain("eth_sendTransaction");
    expect(guide).toContain("https://mcp.gulltoppr.dev/mcp");
    expect(guide).toContain("https://api.gulltoppr.dev/");
    expect(guide).toContain("https://mcp.gulltoppr.dev/server.json");
    expect(guide).toContain("https://mcp.gulltoppr.dev/.well-known/mcp-server.json");
    expect(guide).toContain("https://api.gulltoppr.dev/openapi.json");
    expect(guide).toContain("x-mcp-remote");
    expect(guide).toContain("x-repository");
    expect(guide).toContain("RateLimit-Remaining");
    expect(guide).toContain("X-ABI-Included");
    expect(guide).toContain("Block explorers");
    expect(guide).toContain("Coding agents");
    expect(guide).toContain("list_chains");
    expect(guide).toContain("export_registry");
    expect(guide).toContain("has_default_rpc");
    expect(guide).toContain("structured content");
    expect(guide).toContain("MCP\ntools return structured content with output schemas");
    expect(guide).toContain("export_registry` remains NDJSON text");
    expect(skillReadme).toContain("SDK/REST API");
    expect(await readFile(join(process.cwd(), "sdk/README.md"), "utf8")).toContain("ENGINE_ERROR_CODES");
    expect(skillReadme).not.toContain("or the `gulltoppr`)");
    expect(skill).toContain("lookup_selector");
    expect(skill).toContain("requireWalletRequest");
    expect(skill).toContain("method_q");
    expect(skill).toContain("q: \"balance approve transfer\"");
    expect(skill).toContain("kind: \"all\"");
    expect(skill).toContain("limit: 20");
    expect(skill).not.toContain("methodQ:");
    expect(skill).not.toContain("methodLimit:");
    expect(skill).toContain("leads with a `WARNING` before the JSON");
    expect(skill).toContain("structured `provenance`");
    expect(reference).toContain("runtime_metrics");
    expect(reference).toContain("has_default_rpc");
    expect(reference).toContain("proxy, bytecode-match, decompiled");
    expect(reference).toContain("JSON MCP tools");
    expect(reference).toContain("multi-word");
    expect(reference).toContain("NOT_A_WRITE_FN");
    expect(reference).toContain("never both in one request");
    expect(guide).toContain("rpcUrl");
    expect(guide).toContain("leads with a `WARNING` before the JSON");
  });
});
