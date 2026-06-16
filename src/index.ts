/** Entry point — boots the HTTP server. */
import { serve } from "@hono/node-server";
import { app } from "./server.js";
import { config } from "./config.js";

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`gulltoppr engine listening on http://localhost:${info.port}`);
  console.log(`  heimdall-api (decompile rung): ${config.heimdallApiUrl}`);
  console.log(`  etherscan rung: ${config.etherscanApiKey ? "enabled" : "DISABLED (set ETHERSCAN_API_KEY)"}`);
});
