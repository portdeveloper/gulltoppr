# gulltoppr — standalone release plan

> **gulltoppr** lets any AI agent interact with **any contract on any EVM chain**.
> Give it `(chain, address)` → it resolves the ABI (even for *unverified* contracts,
> via heimdall decompilation — the moat), then reads, simulates, and prepares
> **safe, non-custodial** transactions. Agent-first: MCP is the headline, with a
> REST API, a typed SDK (`npm i gulltoppr`), and a Claude Skill.
>
> Released **independently of abi.ninja** (no push access there; we move fast).
> _Norse fit: gulltoppr is Heimdall's horse — the product rides heimdall
> decompilation to reach any contract._

## Decisions (locked)
- **Two repos**, not a monorepo:
  - `portdeveloper/gulltoppr` — the product (engine + SDK + MCP + Skill). Renamed from `abi-ninja-engine`.
  - `portdeveloper/heimdall-api` — the decompiler microservice. Renamed from the Rust `gulltoppr` (it wraps heimdall-rs; matches its Fly app name).
- **SDK** published unscoped as **`gulltoppr`** (`npm i gulltoppr`).

## What stays vs changes
- **Architecture is unchanged** — the four faces + the resolution ladder
  (Etherscan → Sourcify → proxy → heimdall(`heimdall-api`) → 4byte) all stay. This is
  a rebrand + decouple, not a rewrite.
- **abi.ninja tie is cosmetic** — the engine never imported abi.ninja. The only link
  is `prepare_tx`'s optional signing deeplink. Make it **configurable** (`SIGNING_BASE_URL`,
  default still abi.ninja since it's a fine public signing UI we can link to without
  access). Lead with the universal `unsigned_tx` (any wallet signs it). PR #200 stays
  open as goodwill; we don't block on it.

## Rename inventory

| Thing | From | To |
|-------|------|----|
| Product repo | `portdeveloper/abi-ninja-engine` | `portdeveloper/gulltoppr` |
| Decompiler repo | `portdeveloper/gulltoppr` (Rust) | `portdeveloper/heimdall-api` |
| npm SDK | `gulltoppr` | `gulltoppr` (deprecate old → points here) |
| Fly: engine | `abi-ninja-engine` | `gulltoppr` (new app; recreate cache volume) |
| Fly: MCP | `abi-ninja-mcp` | `gulltoppr-mcp` (new app; stateless) |
| Fly: decompiler | `heimdall-api` | _(unchanged — already right)_ |
| MCP server name | `abi-ninja` | `gulltoppr` |
| Skill | `skill/abi-ninja/` | `skill/gulltoppr/` |
| SDK default `baseUrl` | `gulltoppr.fly.dev` | `gulltoppr.fly.dev` |
| Engine `ENGINE_URL` (MCP) | `gulltoppr.fly.dev` | `gulltoppr.fly.dev` |
| `SIGNING_BASE_URL` | (deeplink target) | `SIGNING_BASE_URL`, default `https://abi.ninja` |

> Fly has no in-place app rename → create the new `gulltoppr` / `gulltoppr-mcp`
> apps, deploy, repoint, then destroy the old `abi-ninja-*` apps. The cache volume
> is recreated on the new engine app (cache is disposable).

## Execution checklist (ordered, move-fast)
1. **Free the name:** rename Rust repo `gulltoppr` → `heimdall-api` (GitHub sets up redirects); update its README/description (drop "used in abi.ninja").
2. **Rename product repo:** `abi-ninja-engine` → `gulltoppr`; update local `origin`.
3. **Rebrand the code:** SDK package name → `gulltoppr`; MCP server name → `gulltoppr`; `skill/abi-ninja` → `skill/gulltoppr`; `SIGNING_BASE_URL` (deeplink optional); README/SPEC/IDEATION wording → gulltoppr; update all `abi-ninja-*` URLs to `gulltoppr*`.
4. **Publish SDK** `gulltoppr@0.1.0`; deprecate `gulltoppr` with a pointer.
5. **New Fly apps:** create `gulltoppr` (+ volume) and `gulltoppr-mcp`, set secrets (`ETHERSCAN_API_KEY`), deploy from the renamed repo, verify; then destroy `abi-ninja-engine` / `abi-ninja-mcp`.
6. **Point SDK/MCP defaults** at `gulltoppr.fly.dev`; rebuild/republish SDK; redeploy MCP.
7. **Tests stay green** (65 + 32) through the rename.
8. **Launch surface:** README hub + quickstart, MCP one-line config, submit the remote MCP to registries (e.g. the MCP servers list / smithery-style directories), publish the Skill install.

## Later / optional
- Custom domain (`gulltoppr.dev` / `api.gulltoppr.…`) instead of `*.fly.dev`.
- Own minimal signing page (drop the abi.ninja dependency entirely).
- Ladder TODOs: 4byte rung, `prestateTracer` state-diff, basenames, diamonds.
- Per-bytecode-hash cache dedup; metrics/observability.
