import { MCP_SERVER_VERSION } from "./mcp-server.js";

export const MCP_SERVER_METADATA = {
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  name: "io.github.portdeveloper/gulltoppr",
  title: "🐴 Gulltoppr",
  description: "Resolve EVM ABIs, read, simulate, prepare unsigned tx hand-offs, and decode txs with provenance.",
  websiteUrl: "https://gulltoppr.dev",
  icons: [
    {
      src: "https://gulltoppr.dev/logo-400.png",
      mimeType: "image/png",
      sizes: ["400x400"],
    },
  ],
  repository: {
    url: "https://github.com/portdeveloper/gulltoppr",
    source: "github",
  },
  version: MCP_SERVER_VERSION,
  remotes: [
    {
      type: "streamable-http",
      url: "https://mcp.gulltoppr.dev/mcp",
    },
  ],
} as const;
