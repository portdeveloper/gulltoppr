# gulltoppr

The REST engine for **abi.ninja-for-agents** — the resolution ladder + verb surface
that lets an AI agent go from `(chain, address)` to a correct, simulated, safe
contract interaction. This is "the engine" of the four faces (REST → MCP → SDK →
Skill); see [`../SPEC.md`](../SPEC.md) for the full contract and [`../IDEATION.md`](../IDEATION.md)
for the strategy.

TypeScript + [viem](https://viem.sh) + [Hono](https://hono.dev). The heimdall
decompile rung is delegated over HTTP to **gulltoppr** (kept out-of-process by
design).

## Run

```bash
npm install
npm run dev            # REST engine — tsx watch on http://localhost:8787
npm run mcp            # MCP server — stdio, 7 tools (for agent clients)
npm run mcp:http       # MCP server — Streamable HTTP (remote agents)
npm run typecheck      # tsc --noEmit
npm test               # vitest — unit tests (cache, chains, ladder helpers, args, errors)
```

### Env

| var | default | notes |
|-----|---------|-------|
| `PORT` | `8787` | |
| `HEIMDALL_API_URL` | `https://heimdall-api.fly.dev` | heimdall decompile service (ladder rung 4) |
| `ETHERSCAN_API_KEY` | _(empty)_ | one multichain v2 key; empty disables rung 1 |
| `SIGNING_BASE_URL` | `https://abi.ninja` | base for `prepare_tx` hand-off deeplinks |
| `RATE_LIMIT` | `120` | per-IP requests per window (fixed window); `0` disables |
| `RATE_LIMIT_WINDOW_SEC` | `60` | rate-limit window length |
| `RATE_LIMIT_ALLOW` | _(empty)_ | comma-separated IP allowlist (exempt); private 6PN IPs are always exempt |

## Endpoints (SPEC §4)

| verb | route |
|------|-------|
| `resolve_abi` | `GET /v1/{chain}/{address}/abi` |
| `read_contract` | `POST /v1/{chain}/{address}/read` — `{function, args}` |
| `encode_call` | `POST /v1/{chain}/{address}/encode` — `{function, args, value?}` |
| `simulate` | `POST /v1/{chain}/simulate` — `{from,to,data,value?}` or `{from,address,function,args,value?}` |
| `prepare_tx` | `POST /v1/{chain}/{address}/prepare` — `{function, args, from, value?}` |
| `decode_tx` | `GET /v1/{chain}/tx/{hash}` |
| `resolve_name` | `GET /v1/{chain}/name/{name}` · `GET /v1/{chain}/name/by-address/{address}` |

`{chain}` is an alias (`ethereum`, `base`, `optimism`, `arbitrum`, `polygon`,
`local`) or a numeric id. Pass `?rpc_url=` to override the RPC (required for chains
with no default, e.g. `local`/31337).

```bash
curl localhost:8787/v1/ethereum/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/abi
curl -X POST localhost:8787/v1/ethereum/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/prepare \
  -H 'content-type: application/json' \
  -d '{"function":"approve","args":["0x1111111254EEB25477B68fb85Ed929f73A960582","1000000000000000000"],"from":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"}'
```

## MCP server (SPEC §5)

`npm run mcp` starts a stdio MCP server exposing the same seven verbs as tools. The
tools are a thin adapter over the deployed REST engine via `gulltoppr`
(`ENGINE_URL`), so the MCP shares the engine's persistent cache and Etherscan key —
no duplicated resolution or secrets. Tool descriptions bake in the non-custodial
hand-off model (`prepare_tx` never signs) and lead with provenance warnings when an
ABI is decompiled.

Wire it into an MCP client (Claude Desktop / Claude Code `mcp` config):

```json
{
  "mcpServers": {
    "gulltoppr": {
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "cwd": "/home/ubuntu/repos/abi-agent",
      "env": { "ETHERSCAN_API_KEY": "" }
    }
  }
}
```

Tools: `resolve_abi`, `read_contract`, `encode_call`, `simulate`, `prepare_tx`,
`decode_tx`, `resolve_name`. All are read-only-annotated except `prepare_tx`
(non-destructive — returns an unsigned hand-off, signs nothing).

### Remote (Streamable HTTP)

For agents that can't run a local stdio server, the same MCP is hosted over HTTP at
**https://gulltoppr-mcp.fly.dev/mcp** (`npm run mcp:http` locally; stateless). Point
an HTTP-capable MCP client at that URL:

```json
{ "mcpServers": { "gulltoppr": { "url": "https://gulltoppr-mcp.fly.dev/mcp" } } }
```

Tool registration is shared (`src/mcp-server.ts`) between the stdio entry (`mcp.ts`)
and the HTTP entry (`mcp-http.ts`), deployed via `Dockerfile.mcp` / `fly.mcp.toml`.

## npm SDK

A typed client over this REST surface lives in [`sdk/`](sdk/) (`gulltoppr`) —
`new AbiNinja({ baseUrl }).resolveAbi(...)` / `.read(...)` / `.prepareTx(...)`, plus
a `contract()` helper. It's the third face (after REST and MCP) and the basis for
refactoring abi.ninja's frontend onto a shared client. See [`sdk/README.md`](sdk/README.md).

## Deploy

Live at **https://gulltoppr.fly.dev** (Fly.io, region `cdg` — co-located with
gulltoppr to minimize ladder rung-4 latency). Containerized via the `Dockerfile`
(Node 22, run with `tsx`; ~82 MB image), configured by `fly.toml`.

```bash
flyctl deploy --remote-only --ha=false
# optional: set an Etherscan v2 key to enable ladder rung 1
flyctl secrets set ETHERSCAN_API_KEY=... -a gulltoppr
```

`HEIMDALL_API_URL` / `SIGNING_BASE_URL` / `PORT` are set in `fly.toml [env]`.
Machines auto-stop when idle and auto-start on request.

## Claude Skill

The fourth face: a [Claude Skill](skill/) (`skill/gulltoppr/`) that teaches an agent
the workflow — resolve → check provenance → read or prepare → simulate → hand off —
and the non-custodial safety rules. Install with
`cp -r skill/gulltoppr ~/.claude/skills/gulltoppr`. See [`skill/README.md`](skill/README.md).

## Layout

```
src/
  server.ts        REST routes (Hono), BigInt-safe JSON, error mapping
  index.ts         REST entry / boot
  mcp.ts           MCP server (stdio) — 7 tools over the same verbs
  config.ts        env + defaults
  chains.ts        alias/id → {id, viem chain, rpc}  (SPEC §6)
  clients.ts       cached viem PublicClients
  types.ts         the SPEC §2 data types
  errors.ts        typed ApiError → HTTP status  (SPEC §7)
  resolve/
    index.ts       resolve_abi — the ladder orchestrator (the spine)
    etherscan.ts   rung 1  · sourcify.ts rung 2 · proxy.ts rung 3
    heimdall.ts    rung 4 (gulltoppr) · fourbyte.ts rung 5
    interface.ts   capability manifest builder ("the buttons", SPEC §2.4a)
    selectFunction.ts  name/signature → AbiFunction
  verbs/
    read.ts encode.ts simulate.ts prepare.ts decodeTx.ts resolveName.ts
    args.ts        JSON-arg → viem-typed coercion
```

## Status

**Working end-to-end** (verified against live mainnet): the full ladder, the
capability manifest, `read_contract`, `encode_call`, `prepare_tx` (with eth_call
simulation + deeplink + provenance warnings), `decode_tx` (via gulltoppr), and ENS
`resolve_name` — exposed over **both** the REST surface and the **MCP server**
(stdio handshake + all 7 tools + a live tool call verified).

**Stubbed / TODO** (clearly marked in-code):
- **4byte rung 5** — returns null; ladder ends in `ABI_NOT_FOUND` instead of a
  selector-only ABI. Needs bytecode selector scan + 4byte.directory lookup.
- **`simulate` state_diff** — empty; needs `prestateTracer`. `asset_changes`/`logs`
  come from `debug_traceCall` (callTracer) when the RPC supports it, else empty.
- **basenames** (`*.base.eth`) — `resolve_name` only does mainnet ENS today.
- **diamonds** (EIP-2535) — proxy detection covers 1967/UUPS/transparent/beacon/1167.
- **`decode_tx`** — doesn't yet layer a verified ABI over the heimdall decode for
  real event/param names.
- **caching** — no result cache yet; every `resolve_abi` re-runs the ladder
  (gulltoppr caches its own decompiles).
