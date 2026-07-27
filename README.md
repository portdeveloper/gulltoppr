# 🐴 gulltoppr

![An agent resolving a live unverified MEV bot via gulltoppr: decompiled ABI, provenance warning, registry-proven name, live read](assets/demo.gif)

*A real session: an unverified MEV bot that traded seconds earlier (no source, no ABI anywhere) resolved to a full interface in two MCP tool calls.*

The REST engine for **gulltoppr**: the resolution ladder + verb surface
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
npm run dev            # REST engine: tsx watch on http://localhost:8787
npm run mcp            # MCP server: stdio tools for agent clients
npm run mcp:http       # MCP server: Streamable HTTP (remote agents)
npm run typecheck      # tsc --noEmit
npm test               # vitest unit tests (cache, chains, ladder helpers, args, errors)
npm run verify         # root typecheck/test/audit + SDK build/test/audit
npm run docker:build   # build the REST engine deployment image
npm run docker:build:mcp # build the Streamable HTTP MCP deployment image
npm run docker:smoke   # start both deployment images and check health/discovery/registry metadata
npm run test:live      # opt-in live contract smoke tests (RPC/decompiler/network)
```

Set `LIVE_ENGINE_BASE_URL=https://api.gulltoppr.dev` with `npm run test:live` to
smoke a deployed engine instead of the local in-process server. The scheduled live
GitHub Action runs the local path; manual dispatch can set the same deployed URL.

### Env

| var | default | notes |
|-----|---------|-------|
| `PORT` | `8787` | |
| `HEIMDALL_API_URL` | `http://heimdall-api.flycast` | heimdall decompile service (ladder rung 4). Private to the Fly org since 2026-07-27 — point this at your own instance when running outside it, or rung 4 falls back to selector-only via 4byte |
| `HEIMDALL_CONCURRENCY` | `2` | per-process cap on outbound decompile/decode requests; `0` disables |
| `HEIMDALL_QUEUE_TIMEOUT_MS` | `5000` | max time a gulltoppr request can wait for an outbound concurrency slot |
| `ENS_RPC_URL` | `https://ethereum-rpc.publicnode.com` | mainnet RPC for ENS/Basenames Universal Resolver calls; use a private RPC in production |
| `ETHERSCAN_API_KEY` | _(empty)_ | one multichain v2 key; empty disables rung 1 |
| `ETHERSCAN_RATE_LIMIT` | `4` | per-process fixed-window budget for the shared Etherscan key; `0` disables |
| `ETHERSCAN_RATE_WINDOW_SEC` | `1` | Etherscan budget window length |
| `SIGNING_BASE_URL` | `https://abi.ninja` | base for `prepare_tx` hand-off deeplinks |
| `RATE_LIMIT` | `120` | per-IP requests per window (fixed window); `0` disables |
| `RATE_LIMIT_WINDOW_SEC` | `60` | rate-limit window length |
| `RATE_LIMIT_ALLOW` | _(empty)_ | comma-separated IP allowlist (exempt); private 6PN IPs are always exempt |
| `ANTHROPIC_API_KEY` | _(empty)_ | enables the registry's LLM propose-and-verify pass on decompiles; empty disables |
| `REGISTRY_LLM_MODEL` | `claude-opus-4-8` | model for propose-and-verify |

## Endpoints (SPEC §4)

| verb | route |
|------|-------|
| discovery | `GET /` · root discovery document with REST/MCP links, verbs, utility tools, and the `prepare_tx` safety gate |
| OpenAPI | `GET /openapi.json` · machine-readable REST contract for coding agents and integrations |
| agent guide | `GET /llms.txt` · compact LLM/coding-agent guide; also published at `https://gulltoppr.dev/llms.txt` |
| `resolve_abi` | `GET /v1/{chain}/{address}/abi?include_abi=&method_q=&method_kind=&method_limit=` · set `include_abi=false` for compact manifest/provenance without raw ABI |
| `read_contract` | `POST /v1/{chain}/{address}/read` · body `{function, args}` |
| `encode_call` | `POST /v1/{chain}/{address}/encode` · body `{function, args, value?}` |
| `simulate` | `POST /v1/{chain}/simulate` · body `{from,to,data,value?}` or `{from,address,function,args,value?}`; never mix both forms |
| `prepare_tx` | `POST /v1/{chain}/{address}/prepare` · body `{function, args, from, value?}` |
| `decode_tx` | `GET /v1/{chain}/tx/{hash}` |
| `resolve_name` | `GET /v1/{chain}/name/{name}` · `GET /v1/{chain}/name/by-address/{address}` |
| chain catalog | `GET /v1/chains?q=&testnets=&has_default_rpc=` · viem-backed aliases with `testnet`/`has_default_rpc` flags for UI clients |
| registry lookup | `GET /v1/lookup/{selector}` · 4-byte (function/error) or 32-byte (event topic0), chain-independent |
| registry stats | `GET /v1/registry/stats` |
| registry export | `GET /v1/registry/export` · CC0 NDJSON selector commons (`X-License: CC0-1.0`) |
| runtime metrics | `GET /v1/metrics` · in-process rung/RPC attempts, latency, misses, and failure rates |

GET routes set explicit `Cache-Control`: verified ABI responses cache longest,
proxy ABI responses are short-lived, transaction decodes are immutable, the OpenAPI
contract is cacheable, and operational endpoints such as `/health` and
`/v1/metrics` are `no-store`. Rate-limited routes expose `RateLimit-Limit`,
`RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` on 429 responses. ABI
resolves also return `X-Source`, `X-Confidence`, `X-Cache`, `X-Elapsed-Ms`, and
`X-ABI-Included`.

### The registry (selector commons)

The engine seeds an open selector→signature registry as a byproduct of resolution:

- Every **verified** resolution (Etherscan/Sourcify) harvests ground-truth
  `selector → signature` pairs for functions, events (full 32-byte topic0,
  collision-free), and errors. Proof grade: `verified-source`.
- Resolutions are also indexed by **skeleton hash** (runtime bytecode with the
  solc metadata trailer stripped), so byte-identical clones resolve via a new
  `bytecode-match` rung without re-running the ladder. Verified claims are
  capped to `partial` for clones (this address's source was never verified), and
  `provenance.bytecode_match` points at the original chain/address/source/confidence
  that supplied the reused ABI.
- Decompiled ABIs get `Unresolved_<selector>` names replaced from proven
  registry entries, and (when `ANTHROPIC_API_KEY` is set) a fire-and-forget
  **propose-and-verify** pass asks Claude for candidate signatures and accepts
  only those where `keccak256(sig)[:4]` reproduces the selector: proof grade
  `keccak-proven` (signature proven; semantics still inferred).
- Public 4byte fallback labels are also selector-matched locally before use, but
  remain unproven labels and never enter the commons as proof.

Only the engine's own pipeline writes to the registry; no open submissions
(that's how 4byte got collision-poisoned).

The accumulated data is published as a **CC0 dataset**:
[`evm-abi-commons`](https://github.com/portdeveloper/evm-abi-commons)
(regenerate any time from `GET /v1/registry/export`; the response is NDJSON and
includes `X-License: CC0-1.0` plus a license `Link` header). Lookup/export entries
include proof grade and, for harvested verified-source entries when known, the
source `chain` and `address`. SDK users can call `lookupSelector`,
`registryStats`, and `exportRegistry` directly.

`{chain}` is any alias from `GET /v1/chains` (backed by `viem/chains`) or a
numeric id. Chain entries include `testnet` and `has_default_rpc` so agents can
decide when to ask for `rpc_url`; `q` matches ids, names, aliases, native symbols,
and multi-word searches such as `bnb chain`. Pass `?rpc_url=` to override the RPC
(required for chains with no default, e.g. `local`/31337; this is how any EVM
chain works before it has a built-in alias).

For agent contexts, prefer `include_abi=false` on `resolve_abi` unless you need the
raw JSON ABI. The compact response preserves `interface`, `provenance`, `proxy`,
`token`, and `abi_for`, and marks `abi_omitted: true`. For large contracts, add
`method_q`, `method_kind=read|write|all`, and `method_limit` to return only the
manifest methods relevant to the user's intent.

```bash
curl localhost:8787/v1/ethereum/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/abi
curl -X POST localhost:8787/v1/ethereum/0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2/prepare \
  -H 'content-type: application/json' \
  -d '{"function":"approve","args":["0x1111111254EEB25477B68fb85Ed929f73A960582","1000000000000000000"],"from":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"}'
```

`prepare_tx.safety.signing_recommended` gates the hand-off. If simulation fails,
`risk_level` is `blocked`, `deeplink` is empty, and `wallet_request` is omitted.
When signing is recommended, `wallet_request` is an EIP-1193-shaped
`eth_sendTransaction` payload with hex JSON-RPC quantities for wallet/explorer/app
integrations. Decompiled or selector-only writes are `high` risk and require
explicit user confirmation of selector + intent. Positive token/NFT spender
approvals are `medium` risk with `spending_approval`. Token/NFT outflows from the
transfer source, whether trace-derived or inferred from a standard token/NFT
transfer, are `medium` risk with `asset_outflow`. Clients should show both before
hand-off.

Integration recipes for wallets, block explorers, coding agents, and MCP clients
are published at [`docs/integrations.md`](docs/integrations.md).

## MCP server (SPEC §5)

`npm run mcp` starts a stdio MCP server exposing the seven core verbs plus
read-only utility tools for chains, selector commons, and runtime metrics. The
tools are a thin adapter over the deployed REST engine
(`ENGINE_URL`), so the MCP shares the engine's persistent cache and Etherscan key;
no duplicated resolution or secrets. Tool descriptions bake in the non-custodial
hand-off model (`prepare_tx` never signs), lead with provenance warnings for
partial/proxy/bytecode-match/decompiled ABI results, and require
`prepare_tx.safety.signing_recommended` before a signing deeplink or wallet request
is handed to the user. JSON MCP tools expose output schemas and
`structuredContent`; clients can branch on `provenance`, decoded calls,
simulations, selector results, metrics, and `safety` without scraping text.

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

Core tools: `resolve_abi`, `read_contract`, `encode_call`, `simulate`,
`prepare_tx`, `decode_tx`, `resolve_name`. Utility tools: `list_chains`,
`lookup_selector`, `registry_stats`, `export_registry`, `runtime_metrics`. All are
read-only-annotated except `prepare_tx` (non-destructive: returns an unsigned
hand-off, signs nothing).

### Remote (Streamable HTTP)

For agents that can't run a local stdio server, the same MCP is hosted over HTTP at
**https://mcp.gulltoppr.dev/mcp** (`npm run mcp:http` locally; stateless). Point
an HTTP-capable MCP client at that URL:

```json
{ "mcpServers": { "gulltoppr": { "url": "https://mcp.gulltoppr.dev/mcp" } } }
```

Tool registration is shared (`src/mcp-server.ts`) between the stdio entry (`mcp.ts`)
and the HTTP entry (`mcp-http.ts`), deployed via `Dockerfile.mcp` / `fly.mcp.toml`.
MCP directory metadata lives in `server.json` and advertises the same remote URL,
repository, homepage, and icon. The remote MCP service also serves the same
metadata at `https://mcp.gulltoppr.dev/server.json` and
`https://mcp.gulltoppr.dev/.well-known/mcp-server.json`.

## npm SDK

A typed client over this REST surface lives in [`sdk/`](sdk/) (`gulltoppr`):
`new Gulltoppr({ baseUrl }).resolveAbi(...)` / `.read(...)` / `.prepareTx(...)`, plus
a `contract()` helper. It's the third face (after REST and MCP) and the basis for
wallet, explorer, and app integrations. See [`sdk/README.md`](sdk/README.md).

## Deploy

Live at **https://api.gulltoppr.dev** (Fly.io app `gulltoppr`, region `cdg`, co-located with
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
the workflow (resolve → check provenance → read or prepare → simulate → hand off)
and the non-custodial safety rules. Install with
`cp -r skill/gulltoppr ~/.claude/skills/gulltoppr`. See [`skill/README.md`](skill/README.md).

## Layout

```
src/
  server.ts        REST routes (Hono), BigInt-safe JSON, error mapping
  index.ts         REST entry / boot
  mcp.ts           MCP server (stdio): core verbs plus read-only utility tools
  config.ts        env + defaults
  metrics.ts       in-process rung/RPC latency and failure counters
  chains.ts        alias/id → {id, viem chain, rpc}  (SPEC §6)
  clients.ts       cached viem PublicClients
  types.ts         the SPEC §2 data types
  errors.ts        typed ApiError → HTTP status  (SPEC §7)
  resolve/
    index.ts       resolve_abi: the ladder orchestrator (the spine)
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
simulation + deeplink/wallet hand-off + provenance warnings), `decode_tx` (via gulltoppr plus
optional resolved-ABI calldata enrichment), and
chain-aware ENS/Basenames `resolve_name`, all exposed over **both** the REST surface and the **MCP server**
(stdio handshake + core tools/utilities + a live tool call verified). The live smoke suite
also covers proxies, unverified decompiles, arbitrary `rpc_url` chains, Monad,
Monad testnet, and `prepare_tx`.

**Best-effort caveats**:
- **`simulate` traces**: `state_diff` comes from `debug_traceCall`
  (`prestateTracer` diff mode) and `asset_changes`/`logs` come from `callTracer`
  when the RPC supports those debug APIs; public RPCs often return empty arrays.
