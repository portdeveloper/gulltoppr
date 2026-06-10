/**
 * Shared MCP server factory — SPEC §5. One tool per verb. The tools are a thin
 * adapter over the deployed REST engine via gulltoppr, so the MCP
 * server shares the engine's persistent cache and Etherscan key (no in-process
 * resolution, no duplicated secrets). Both transports import this:
 *  - mcp.ts        → stdio   (Claude Desktop / Code / local clients)
 *  - mcp-http.ts   → Streamable HTTP (remote agents, no local install)
 *
 * Baked in per SPEC §5: prepare_tx's description states the non-custodial hand-off
 * explicitly; decompiled/selector-only results LEAD with the provenance warning.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AbiNinja, AbiNinjaError } from "gulltoppr";
import type { Address } from "viem";

import { safeStringify } from "./util.js";
import { config } from "./config.js";

// Single client pointed at the deployed engine (its cache + Etherscan key serve us).
const ninja = new AbiNinja({ baseUrl: config.engineUrl });

// ── result helpers ──────────────────────────────────────────────────────────
function ok(data: unknown, lead?: string): CallToolResult {
  const text = lead ? `${lead}\n\n${safeStringify(data, 2)}` : safeStringify(data, 2);
  return { content: [{ type: "text", text }] };
}
function fail(e: unknown): CallToolResult {
  const body =
    e instanceof AbiNinjaError
      ? { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } }
      : { error: { code: "INTERNAL", message: (e as Error).message } };
  return { content: [{ type: "text", text: safeStringify(body, 2) }], isError: true };
}
/** Wrap a handler so engine errors become MCP isError results, never crashes. */
function guard<A>(fn: (args: A) => Promise<CallToolResult>) {
  return async (args: A): Promise<CallToolResult> => {
    try {
      return await fn(args);
    } catch (e) {
      return fail(e);
    }
  };
}

// ── shared zod fields ────────────────────────────────────────────────────────
const chain = z.string().describe('Chain alias ("ethereum", "base", "optimism", "arbitrum", "polygon", "local") or numeric chain id.');
const address = z.string().describe("0x contract address.");
const fn = z.string().describe('Function name, or full signature like "transfer(address,uint256)" if overloaded.');
const args = z.array(z.any()).default([]).describe("Function arguments, in order. Pass uint values as decimal strings.");
const value = z.string().optional().describe("Native value in wei (decimal string), for payable functions.");
const rpc_url = z.string().optional().describe("Override RPC URL. Required for chains with no default (e.g. local/31337).");
const from = z.string().describe("The sender address (the user's wallet). No key is needed — nothing is signed.");

const READ = { readOnlyHint: true, openWorldHint: true } as const;
const opts = (rpcUrl?: string) => (rpcUrl ? { rpcUrl } : undefined);

/** Build a fully-configured MCP server (all 7 verb tools registered). */
export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "gulltoppr", version: "0.1.0" });

  server.registerTool(
    "resolve_abi",
    {
      title: "Resolve contract ABI",
      description:
        "Resolve a contract's interface from chain + address via a fallback ladder " +
        "(Etherscan → Sourcify → proxy → heimdall decompile → 4byte). Returns a capability " +
        "manifest (read vs write functions, the 'buttons'), proxy chain, token metadata, and " +
        "PROVENANCE. ALWAYS read `provenance`: a `decompiled` ABI has synthetic function names — " +
        "treat it with care and confirm intent before writing.",
      inputSchema: { chain, address, rpc_url },
      annotations: READ,
    },
    guard(async ({ chain, address, rpc_url }) => {
      const r = await ninja.resolveAbi(chain, address as Address, opts(rpc_url));
      const lead = r.provenance.names_synthetic
        ? `⚠️ ${r.provenance.confidence.toUpperCase()} ABI — ${r.provenance.notes ?? "function/param names are inferred; verify intent."}`
        : undefined;
      return ok(r, lead);
    }),
  );

  server.registerTool(
    "read_contract",
    {
      title: "Read a contract (view/pure)",
      description: "Call a view/pure function and get the decoded result. No wallet, no cost. Rejects state-mutating functions.",
      inputSchema: { chain, address, function: fn, args, rpc_url },
      annotations: READ,
    },
    guard(async ({ chain, address, function: f, args, rpc_url }) =>
      ok(await ninja.read(chain, address as Address, f, args, opts(rpc_url))),
    ),
  );

  server.registerTool(
    "encode_call",
    {
      title: "Encode a function call",
      description: "Encode a function call to calldata (0x…) without sending anything.",
      inputSchema: { chain, address, function: fn, args, value, rpc_url },
      annotations: READ,
    },
    guard(async ({ chain, address, function: f, args, value, rpc_url }) =>
      ok(await ninja.encode(chain, address as Address, f, args, { value, ...opts(rpc_url) })),
    ),
  );

  server.registerTool(
    "simulate",
    {
      title: "Simulate a transaction",
      description:
        "Simulate a call and return success, gas, decoded return, and best-effort state diff / " +
        "asset changes / logs. Provide a high-level call (address + function + args) or raw (to + data).",
      inputSchema: {
        chain, from,
        address: address.optional(), function: fn.optional(), args: args.optional(),
        to: z.string().optional().describe("Raw form: target address."),
        data: z.string().optional().describe("Raw form: calldata (0x…)."),
        value, rpc_url,
      },
      annotations: READ,
    },
    guard(async ({ chain, from, address, function: f, args, to, data, value, rpc_url }) => {
      const simArgs: Parameters<typeof ninja.simulate>[1] = { from: from as Address };
      if (address) simArgs.address = address as Address;
      if (f) simArgs.function = f;
      if (args) simArgs.args = args;
      if (to) simArgs.to = to as Address;
      if (data) simArgs.data = data as `0x${string}`;
      if (value) simArgs.value = value;
      return ok(await ninja.simulate(chain, simArgs, opts(rpc_url)));
    }),
  );

  server.registerTool(
    "prepare_tx",
    {
      title: "Prepare an unsigned transaction (hand-off)",
      description:
        "Prepare a contract WRITE for the user to sign. Returns an UNSIGNED transaction, its " +
        "simulation, a human-readable summary, an abi.ninja signing deeplink, and warnings. " +
        "IMPORTANT: this tool NEVER signs or broadcasts. Present the summary + simulation + " +
        "warnings to the user and hand them the `deeplink` — they sign in their own wallet. " +
        "If `warnings` is non-empty (decompiled ABI, proxy, or a reverting simulation), surface it.",
      inputSchema: { chain, address, function: fn, args, from, value, rpc_url },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    guard(async ({ chain, address, function: f, args, from, value, rpc_url }) => {
      const r = await ninja.prepareTx(chain, address as Address, f, args, { from: from as Address, value, ...opts(rpc_url) });
      const lead = r.warnings.length ? `⚠️ ${r.warnings.join(" ")}` : undefined;
      return ok(r, lead);
    }),
  );

  server.registerTool(
    "decode_tx",
    {
      title: "Explain a transaction",
      description: "Decode what a transaction did: decoded calldata (and trace when available), via heimdall.",
      inputSchema: { chain, tx_hash: z.string().describe("0x… transaction hash."), rpc_url },
      annotations: READ,
    },
    guard(async ({ chain, tx_hash, rpc_url }) => ok(await ninja.decodeTx(chain, tx_hash, opts(rpc_url)))),
  );

  server.registerTool(
    "resolve_name",
    {
      title: "Resolve ENS ⇄ address",
      description: "Resolve an ENS name to an address, or an address to its primary ENS name.",
      inputSchema: { name: z.string().describe("An ENS name (vitalik.eth) or a 0x address."), chain: chain.optional() },
      annotations: READ,
    },
    guard(async ({ name, chain }) => ok(await ninja.resolveName(name, chain))),
  );

  return server;
}
