/**
 * MCP server over stdio — drops into Claude Desktop / Claude Code / any local MCP
 * client. Tool registration lives in mcp-server.ts (shared with the HTTP transport).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./mcp-server.js";
import { MCP_TOOLS } from "./agentSurface.js";

const transport = new StdioServerTransport();
await createMcpServer().connect(transport);
// stderr is safe to log on (stdout is the JSON-RPC channel).
console.error(`gulltoppr MCP server ready on stdio (${MCP_TOOLS.length} tools).`);
