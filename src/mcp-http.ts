/**
 * MCP server over Streamable HTTP — remote agents connect without any local install.
 * Stateless: a fresh server + transport per POST (no session state to manage), which
 * scales trivially and fits a public read-mostly tool surface.
 *
 * POST /mcp  → JSON-RPC (initialize / tools/list / tools/call)
 * GET  /mcp  → 405 (no server-initiated SSE stream in stateless mode)
 * GET  /health
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp-server.js";
import { RateLimiter, clientIpFromHeaders } from "./rateLimit.js";
import { config } from "./config.js";

const PORT = Number(process.env.PORT) || 8788;

const limiter = new RateLimiter(config.rateLimitMax, config.rateLimitWindowMs, config.rateLimitAllow);
function ipOf(req: IncomingMessage): string {
  return clientIpFromHeaders((h) => {
    const v = req.headers[h];
    return Array.isArray(v) ? v[0] : v;
  });
}

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id, mcp-protocol-version, last-event-id");
  res.setHeader("Access-Control-Expose-Headers", "mcp-session-id, mcp-protocol-version");
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

const server = createServer(async (req, res) => {
  cors(res);
  const path = (req.url ?? "").split("?")[0];

  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (path === "/health" || path === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, mcp: "streamable-http", endpoint: "/mcp" }));
    return;
  }
  if (path !== "/mcp") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found; POST JSON-RPC to /mcp" }));
    return;
  }

  if (req.method === "POST") {
    const rl = limiter.check(ipOf(req));
    res.setHeader("RateLimit-Limit", String(rl.limit));
    res.setHeader("RateLimit-Remaining", String(rl.remaining));
    res.setHeader("RateLimit-Reset", String(rl.resetSec));
    if (!rl.ok) {
      res.setHeader("Retry-After", String(rl.resetSec));
      return jsonRpcError(res, 429, -32000, `Rate limit exceeded (${rl.limit}/${config.rateLimitWindowMs / 1000}s). Retry in ${rl.resetSec}s.`);
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      return jsonRpcError(res, 400, -32700, "Parse error");
    }
    // Stateless: new server + transport per request, torn down when the response closes.
    const mcp = createMcpServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) jsonRpcError(res, 500, -32603, `Internal error: ${(e as Error).message}`);
    }
    return;
  }

  // GET/DELETE: no long-lived stream in stateless mode.
  jsonRpcError(res, 405, -32000, "Method not allowed (stateless server — POST JSON-RPC to /mcp).");
});

server.listen(PORT, () => {
  console.error(`abi.ninja MCP (Streamable HTTP) on http://0.0.0.0:${PORT}/mcp (7 tools, stateless)`);
});
