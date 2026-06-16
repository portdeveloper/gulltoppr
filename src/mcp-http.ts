/**
 * MCP server over Streamable HTTP — remote agents connect without any local install.
 *
 * POST /mcp  → JSON-RPC (initialize / tools/list / tools/call)
 * GET  /mcp  → 405 (no server-initiated SSE stream in stateless mode)
 * GET  /server.json and /.well-known/mcp-server.json → MCP directory metadata
 * GET  /health
 */
import { createMcpHttpServer } from "./mcp-http-server.js";
import { MCP_TOOLS } from "./agentSurface.js";

const PORT = Number(process.env.PORT) || 8788;

createMcpHttpServer().listen(PORT, () => {
  console.error(`gulltoppr MCP (Streamable HTTP) on http://0.0.0.0:${PORT}/mcp (${MCP_TOOLS.length} tools, stateless)`);
});
