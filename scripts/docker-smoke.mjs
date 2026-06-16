#!/usr/bin/env node
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const exec = promisify(execFile);

const targets = [
  { image: "gulltoppr-engine:ci", name: "gulltoppr-engine-smoke", path: "/health", discoveryChecks: true },
  {
    image: "gulltoppr-mcp:ci",
    name: "gulltoppr-mcp-smoke",
    path: "/health",
    metadataPaths: ["/server.json", "/.well-known/mcp-server.json"],
    mcpPostChecks: true,
  },
];

async function docker(args) {
  return exec("docker", args, { maxBuffer: 1024 * 1024 });
}

async function portFor(container) {
  const { stdout } = await docker(["port", container, "8080/tcp"]);
  const line = stdout.trim().split("\n")[0];
  const match = /:(\d+)$/.exec(line ?? "");
  if (!match) throw new Error(`Could not parse mapped port for ${container}: ${stdout}`);
  return Number(match[1]);
}

async function logs(container) {
  try {
    const { stdout, stderr } = await docker(["logs", container]);
    return `${stdout}${stderr}`;
  } catch (e) {
    return (e instanceof Error ? e.message : String(e));
  }
}

async function waitForHealth(container, url) {
  const deadline = Date.now() + 20_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      last = `${res.status} ${res.statusText}`;
      if (res.ok) {
        const body = await res.json();
        if (body?.ok === true) return;
        last = `unexpected body ${JSON.stringify(body)}`;
      }
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}: ${last}\n${await logs(container)}`);
}

async function fetchOk(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Expected ${url} to return 2xx, got ${res.status}`);
  return res;
}

async function fetchJson(url) {
  const res = await fetchOk(url);
  return res.json();
}

async function fetchText(url) {
  const res = await fetchOk(url);
  return res.text();
}

async function checkEngineDiscovery(baseUrl, image) {
  const discovery = await fetchJson(`${baseUrl}/`);
  if (discovery?.openapi !== "/openapi.json" || discovery?.llms !== "/llms.txt" || discovery?.chain_catalog !== "/v1/chains") {
    throw new Error(`Unexpected discovery payload from ${baseUrl}/: ${JSON.stringify(discovery)}`);
  }
  if (!Array.isArray(discovery?.verbs) || !discovery.verbs.includes("prepare_tx") || !discovery.verbs.includes("decode_tx")) {
    throw new Error(`Discovery verbs missing core tools at ${baseUrl}/: ${JSON.stringify(discovery?.verbs)}`);
  }
  if (!discovery?.safety_gate?.prepare_tx?.includes("safety.signing_recommended")) {
    throw new Error(`Discovery safety gate missing prepare_tx guidance at ${baseUrl}/`);
  }

  const openapiUrl = `${baseUrl}/openapi.json`;
  const openapiResponse = await fetchOk(openapiUrl);
  if (!openapiResponse.headers.get("cache-control")?.includes("max-age=300") || !openapiResponse.headers.get("ratelimit-limit")) {
    throw new Error(`OpenAPI response missing cache/rate-limit headers at ${openapiUrl}`);
  }
  const openapi = await openapiResponse.json();
  if (openapi?.openapi !== "3.1.0" || !openapi?.paths?.["/v1/{chain}/{address}/prepare"]) {
    throw new Error(`OpenAPI contract missing expected REST surface at ${baseUrl}/openapi.json`);
  }
  const abiHeaders = openapi.paths?.["/v1/{chain}/{address}/abi"]?.get?.responses?.["200"]?.headers;
  if (!abiHeaders?.["X-ABI-Included"] || !abiHeaders?.["Cache-Control"] || !abiHeaders?.["RateLimit-Limit"]) {
    throw new Error(`OpenAPI ABI response headers missing operational metadata at ${openapiUrl}`);
  }
  const retryAfter = openapi.paths?.["/v1/{chain}/{address}/abi"]?.get?.responses?.["429"]?.headers?.["Retry-After"];
  const rateLimitedHeaders = openapi.paths?.["/v1/{chain}/{address}/abi"]?.get?.responses?.["429"]?.headers;
  if (!retryAfter || !rateLimitedHeaders?.["RateLimit-Limit"] || !rateLimitedHeaders?.["RateLimit-Remaining"] || !rateLimitedHeaders?.["RateLimit-Reset"]) {
    throw new Error(`OpenAPI 429 response missing Retry-After/rate-limit headers at ${openapiUrl}`);
  }

  const llms = await fetchText(`${baseUrl}/llms.txt`);
  if (!llms.includes("safety.signing_recommended") || !llms.includes("runtime_metrics")) {
    throw new Error(`llms.txt missing agent safety/metrics guidance at ${baseUrl}/llms.txt`);
  }

  const chainCatalog = await fetchJson(`${baseUrl}/v1/chains?testnets=false&has_default_rpc=true`);
  if (!Array.isArray(chainCatalog?.chains) || !chainCatalog.chains.some((chain) => chain?.aliases?.includes("ethereum"))) {
    throw new Error(`Chain catalog missing ethereum mainnet entry at ${baseUrl}/v1/chains`);
  }
  const chainSearch = await fetchJson(`${baseUrl}/v1/chains?q=bnb+chain&testnets=false&has_default_rpc=true`);
  if (!Array.isArray(chainSearch?.chains) || !chainSearch.chains.some((chain) => chain?.id === 56 && chain?.name === "BNB Smart Chain")) {
    throw new Error(`Chain catalog q search failed for BNB Smart Chain at ${baseUrl}/v1/chains`);
  }

  const selectorLookup = await fetchJson(`${baseUrl}/v1/lookup/0xa9059cbb`);
  if (selectorLookup?.selector !== "0xa9059cbb" || !Array.isArray(selectorLookup?.entries)) {
    throw new Error(`Selector lookup returned unexpected body at ${baseUrl}/v1/lookup/0xa9059cbb: ${JSON.stringify(selectorLookup)}`);
  }

  const registryStatsUrl = `${baseUrl}/v1/registry/stats`;
  const registryStatsResponse = await fetchOk(registryStatsUrl);
  if (!registryStatsResponse.headers.get("cache-control")?.includes("max-age=60") || !registryStatsResponse.headers.get("ratelimit-limit")) {
    throw new Error(`Registry stats missing cache/rate-limit headers at ${registryStatsUrl}`);
  }
  const registryStats = await registryStatsResponse.json();
  if (typeof registryStats?.selectors !== "object" || typeof registryStats?.bytecodes !== "number") {
    throw new Error(`Registry stats returned unexpected body at ${baseUrl}/v1/registry/stats: ${JSON.stringify(registryStats)}`);
  }

  const registryExportUrl = `${baseUrl}/v1/registry/export`;
  const registryExport = await fetchOk(registryExportUrl);
  if (!registryExport.headers.get("content-type")?.includes("ndjson") || registryExport.headers.get("x-license") !== "CC0-1.0") {
    throw new Error(`Registry export missing NDJSON/CC0 headers at ${registryExportUrl}`);
  }
  await registryExport.text();

  const metricsUrl = `${baseUrl}/v1/metrics`;
  const metricsResponse = await fetchOk(metricsUrl);
  if (metricsResponse.headers.get("cache-control") !== "no-store" || !metricsResponse.headers.get("ratelimit-limit")) {
    throw new Error(`Metrics endpoint missing no-store/rate-limit headers at ${metricsUrl}`);
  }
  const metrics = await metricsResponse.json();
  if (typeof metrics?.uptime_seconds !== "number" || typeof metrics?.metrics !== "object") {
    throw new Error(`Metrics endpoint returned unexpected body at ${baseUrl}/v1/metrics: ${JSON.stringify(metrics)}`);
  }

  console.log(`[docker-smoke] ${image} REST discovery OK at ${baseUrl}`);
}

async function smoke(target) {
  const container = `${target.name}-${process.pid}`;
  await docker(["rm", "-f", container]).catch(() => {});
  try {
    const { stdout } = await docker([
      "run",
      "-d",
      "--rm",
      "--name",
      container,
      "-p",
      "127.0.0.1::8080",
      target.image,
    ]);
    const id = stdout.trim();
    if (!id) throw new Error(`docker run produced no container id for ${target.image}`);
    const port = await portFor(container);
    const url = `http://127.0.0.1:${port}${target.path}`;
    await waitForHealth(container, url);
    console.log(`[docker-smoke] ${target.image} healthy at ${url}`);
    const baseUrl = `http://127.0.0.1:${port}`;
    if (target.discoveryChecks) {
      await checkEngineDiscovery(baseUrl, target.image);
    }
    for (const metadataPath of target.metadataPaths ?? []) {
      const metadataUrl = `${baseUrl}${metadataPath}`;
      const metadata = await fetchOk(metadataUrl);
      if (metadata.headers.get("access-control-allow-origin") !== "*" || !metadata.headers.get("cache-control")?.includes("max-age=300")) {
        throw new Error(`MCP metadata missing CORS/cache headers at ${metadataUrl}`);
      }
      const body = await metadata.json();
      if (body?.name !== "io.github.portdeveloper/gulltoppr" || body?.remotes?.[0]?.url !== "https://mcp.gulltoppr.dev/mcp") {
        throw new Error(`Unexpected MCP metadata from ${metadataUrl}: ${JSON.stringify(body)}`);
      }
      console.log(`[docker-smoke] ${target.image} metadata OK at ${metadataUrl}`);
    }
    if (target.mcpPostChecks) {
      const rpcUrl = `${baseUrl}/mcp`;
      const malformed = await fetch(rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://agent.example" },
        body: "{",
      });
      if (
        malformed.status !== 400 ||
        malformed.headers.get("access-control-allow-origin") !== "*" ||
        !malformed.headers.get("access-control-expose-headers")?.includes("mcp-session-id") ||
        !malformed.headers.get("ratelimit-limit")
      ) {
        throw new Error(`MCP POST surface missing expected CORS/rate-limit response at ${rpcUrl}`);
      }
      const body = await malformed.json();
      if (body?.jsonrpc !== "2.0" || body?.error?.code !== -32700) {
        throw new Error(`MCP malformed POST returned unexpected JSON-RPC body at ${rpcUrl}: ${JSON.stringify(body)}`);
      }
      console.log(`[docker-smoke] ${target.image} MCP POST surface OK at ${rpcUrl}`);
    }
  } finally {
    await docker(["rm", "-f", container]).catch(() => {});
  }
}

for (const target of targets) {
  await smoke(target);
}
