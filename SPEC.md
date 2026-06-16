# gulltoppr for agents: verb / REST / MCP contract

> The single source of truth for the agent-facing surface. All four faces (REST
> API, MCP server, npm SDK, Skill) implement **the same verbs over the same data
> types**; this doc defines them once so the faces can't drift. Strategy and
> rationale live in `IDEATION.md`; this is the contract.

Status: **draft v0.1** (2026-06-08). Greenfield standalone service; nothing here
must stay backwards-compatible except gulltoppr's existing endpoints.

---

## 0. Foundational decisions (settle the open forks)

These were open in the checkpoint; resolved here so the spec is buildable.

1. **The REST API is a new, standalone service:** the "engine" of IDEATION.md.
   It owns the resolution ladder and the verb surface. Wallets, explorers, apps,
   agent clients, and any signing surface are clients of it.
2. **It calls gulltoppr over HTTP for the heimdall rung; it does not embed
   heimdall.** gulltoppr is already deployed (`https://heimdall-api.fly.dev`) and
   the subprocess-isolation decision (panics/OOM/timeouts contained out-of-process)
   is exactly why we don't want heimdall in the API's address space. The API treats
   gulltoppr as one labeled rung of the ladder.
3. **Verbs are face-agnostic.** Section 3 defines them abstractly. Section 4 maps
   them to REST routes; Section 5 maps the same verbs to MCP tools plus read-only
   utility tools for chains, selector commons, and metrics. The SDK is a typed
   client of Section 4; the Skill teaches the Section 3 workflow.
4. **Non-custodial, always.** No verb ever holds a key, signs, or broadcasts. The
   write path ends at an unsigned tx + simulation + human summary + a signing
   hand-off (`deeplink` or `wallet_request`). The user signs in their own wallet.

---

## 0.5 What we return to the agent (the product shape)

**We return an interaction surface, not an ABI.** gulltoppr's value is not the
JSON ABI; it's the live calling surface (read a value, fill args, prepare a tx). The
raw ABI is what *makes* that surface; it isn't the deliverable. An agent can already
fetch an ABI from Etherscan; what it can't do reliably is go ABI → correctly
encoded → simulated → safe tx. That gap is the product.

So the agent gets two things, which map onto the contract interaction UI a human
would otherwise need:

1. **A capability manifest** (`resolve_abi` → `interface`, §2.4): the "buttons"
   as JSON: read functions vs write functions, each with
   named inputs, types, mutability, per-function provenance, and human hints. This
   is what the agent reasons over to *plan*, and what it shows the user ("here's
   what I can do with this contract"). It's where heimdall's synthetic names /
   unreliable mutability get normalized and honestly tagged.
2. **Execution verbs** (§3): the agent works in `(function, args)` terms and never
   touches calldata or the ABI. `read_contract` returns the decoded answer;
   `prepare_tx` returns a simulated, ready-to-sign hand-off.

One-liner: *"Tell me what you want to do with this contract in plain `(function,
args)` terms; I'll get you the answer (reads) or a safe, simulated, ready-to-sign
transaction (writes)."* The raw ABI is available from `resolve_abi` for agents
running their own viem/ethers, but compact callers can omit it; it is a secondary
field, not the headline.

---

## 1. Design invariants

These hold for every verb, every face. Violating one is a bug, not a tradeoff.

- **Provenance is never hidden.** Every ABI-bearing result carries `provenance`
  (Section 2.2). An agent must be able to tell "verified, NatSpec present" from
  "decompiled, names may be synthetic" without inference.
- **Never return blind calldata for a write.** `prepare_tx` always pairs the
  unsigned tx with a simulation. If simulation fails, the verb returns
  `safety.risk_level: "blocked"`, an empty `deeplink`, and no `wallet_request`;
  it never returns an unsimulated signing hand-off.
- **Reads need no signer.** `read_contract` / `resolve_abi` / `decode_tx` /
  `resolve_name` require no `from` and no key.
- **Chain is explicit.** Every onchain verb takes `chain` (EIP-155 chain id, or a
  known alias from Section 6). No implicit "mainnet".
- **Stateless + cacheable.** No server-side session. Identical inputs → identical
  output (modulo chain state). Caching keys off `(verb, chain, address, …)`.
- **Errors are typed and stable** (Section 7). Same code shape across faces.

---

## 2. Core data types

JSON Schema-ish; `?` = optional. These are shared by REST bodies and MCP tool I/O.

### 2.1 `Address` / `ChainId`
- `Address`: `0x`-prefixed, EIP-55 checksummed on output, accepted any-case on input.
- `ChainId`: integer (e.g. `1`, `8453`, `31337`) or a Section 6 alias string.

### 2.2 `Provenance`: first-class, on every ABI result
```jsonc
{
  "source": "etherscan" | "sourcify" | "proxy-impl" | "bytecode-match" | "heimdall-decompiled" | "4byte",
  "confidence": "verified" | "partial" | "decompiled" | "selector-only",
  "verified": true,                       // source code was verified onchain
  "names_synthetic": false,               // true ⇒ fn/param names may be Unresolved_0x…
  "natspec": false,                       // human docs available
  "bytecode_match": {                     // present when ABI came from bytecode reuse
    "chain": 1,
    "address": "0x…",
    "source": "etherscan",
    "confidence": "verified"
  },
  "notes": "string?"                      // e.g. "names inferred by heimdall; verify intent"
}
```
Confidence ladder, high→low: `verified` (Etherscan/Sourcify source) → `partial`
(proxy impl verified but storage layout assumed, or partial match) → `decompiled`
(heimdall: ABI usable, names synthetic) → `selector-only` (4byte: per-function only,
no full ABI).

### 2.3 `ProxyChain`
```jsonc
{
  "is_proxy": true,
  "pattern": "eip1967" | "uups" | "transparent" | "beacon" | "diamond" | "minimal-1167" | "unknown",
  "hops": [ { "address": "0x…", "role": "proxy" | "implementation" | "beacon" | "facet" } ],
  "resolved_implementation": "0x…?"       // absent for diamonds; facets are listed in hops
}
```

### 2.4 `AbiResult`: output of `resolve_abi`
The **headline is `interface`** (the capability manifest, §0.5): the digested,
agent-legible "what can I do" view. `abi` (raw JSON ABI) is optional and secondary.
```jsonc
{
  "chain": 1,
  "address": "0x…",                       // the queried address
  "interface": { /* 2.4a: the capability manifest, the product */ },
  "abi": [ /* standard JSON ABI: secondary; omitted when include_abi=false */ ],
  "provenance": { /* 2.2 */ },
  "proxy": { /* 2.3, present only if is_proxy */ },
  "token": { "kind": "erc20"|"erc721"|"erc1155"|null, "symbol": "?", "decimals": 18, "name": "?" }?,
  "abi_for": "0x…",                        // impl if classic proxy; queried address for merged diamond ABIs
  "cached": false
}
```
When `include_abi=false`, the response preserves the manifest and metadata but
omits `abi` and includes `"abi_omitted": true`.

### 2.4a `Interface`: the capability manifest ("the buttons")
A normalized, provenance-tagged view of the callable surface, split by what an
agent actually needs to decide: can I just read this, or does it cost a tx? Derived
from `abi`, but it's where decompiled-ABI mutability/names get normalized and hinted.
```jsonc
{
  "reads": [        // view / pure: call freely, no wallet, no cost
    {
      "function": "balanceOf",
      "signature": "balanceOf(address)",
      "inputs":  [ { "name": "owner", "type": "address" } ],
      "outputs": [ { "name": "", "type": "uint256" } ],
      "names_synthetic": false,           // per-function; true if heimdall guessed the name
      "hint": "returns base units; this token has 6 decimals"?
    }
  ],
  "writes": [       // nonpayable / payable: needs prepare_tx → user signs
    {
      "function": "transfer",
      "signature": "transfer(address,uint256)",
      "inputs": [ { "name": "to", "type": "address" }, { "name": "amount", "type": "uint256" } ],
      "payable": false,
      "names_synthetic": false,
      "hint": "amount is in base units (6 decimals): 1 USDC = \"1000000\""?
    }
  ]
}
```
- `reads` = `view`/`pure`; `writes` = everything that mutates (payable flagged).
- When provenance is `decompiled`, mutability is heimdall's best guess;
  `names_synthetic: true` and a `hint` say so per-function, so the agent calibrates.
- `hint` is generated from token metadata (decimals), NatSpec (when verified), and
  selector heuristics: the human-readable nudge a contract UI gives implicitly.

### 2.5 `Call`: the shared call descriptor (input to read/encode/simulate/prepare)
```jsonc
{
  "chain": 1,
  "address": "0x…",
  "function": "transfer",                  // name, OR full signature "transfer(address,uint256)"
  "args": [ "0x…", "1000000" ],            // JSON values; uint as decimal string
  "value": "0"?,                           // wei, decimal string, for payable
  "from": "0x…?"                           // required for simulate/prepare, omit for read/encode
}
```
`function` accepts a bare name when unambiguous, else the full signature; on
overload ambiguity the call fails with `AMBIGUOUS_FUNCTION` listing candidates.

### 2.6 `Simulation`
Backed by raw `eth_call` / `debug_traceCall` against the chain RPC: **no external
simulation provider** (no Tenderly). So `asset_changes` and `state_diff` are
**best-effort**: decoded from the trace's touched slots and emitted logs (e.g.
`Transfer` events → asset deltas). Cheaper, keyless, works on any chain incl. local
31337, at the cost of thinner diffs for contracts that move value without standard
events. `success`/`gas_used`/`revert`/`return_value` are always exact.
```jsonc
{
  "success": true,
  "gas_used": 51234,
  "return_value": { "decoded": [ /* … */ ], "raw": "0x…" }?,
  "state_diff": [
    { "address": "0x…", "slot_label": "balanceOf[0x..]"?, "before": "…", "after": "…" }
  ],
  "asset_changes": [
    { "address": "0x…", "token": "0x…", "symbol": "USDC", "delta": "-1000000", "kind": "erc20" }
  ],
  "logs": [ { "address": "0x…", "event": "Transfer(address,address,uint256)"?, "args": {…}? } ],
  "revert": { "reason": "string", "decoded": "ERC20: insufficient balance"? }?  // present iff !success
}
```

### 2.7 `UnsignedTx`
```jsonc
{ "chainId": 1, "to": "0x…", "from": "0x…", "data": "0x…", "value": "0", "gas": "60000"? }
```

### 2.7a `WalletRequest`
```jsonc
{
  "chainId": 1,                         // routing metadata; switch wallet first
  "method": "eth_sendTransaction",
  "params": [{
    "from": "0x…",
    "to": "0x…",
    "data": "0x…",
    "value": "0x0",
    "gas": "0xea60"
  }]
}
```
`wallet_request` is EIP-1193-shaped for wallets, explorers, and apps that already
own wallet connection. It uses JSON-RPC quantity hex values so clients do not need
to reformat `unsigned_tx`.

### 2.8 `PreparedTx`: output of `prepare_tx`, the hand-off payload
```jsonc
{
  "unsigned_tx": { /* 2.7 */ },
  "simulation": { /* 2.6 */ },
  "human_summary": "Approve 1,000 USDC (6 decimals) for spending by 0xUniswap…",
  "deeplink": "https://abi.ninja/{chain}/{address}?function=…&args=…",   // signing surface
  "wallet_request": { /* 2.7a; omitted when signing_recommended=false */ },
  "warnings": [ "ABI decompiled: names or mutability may be inferred; confirm this is `approve`." ],
  "safety": {
    "signing_recommended": true,
    "risk_level": "low",                 // low | medium | high | blocked
    "requires_human_confirmation": false,
    "reasons": []                        // abi_names_inferred | proxy | simulation_failed | native_value | spending_approval | asset_outflow
  }
}
```
`warnings` is populated from provenance and safety checks: a decompiled ABI, an
unverified implementation, a positive token/NFT spender approval, a trace-derived
asset outflow, or a standard token/NFT transfer intent each appends a warning.
`safety.signing_recommended` is false when simulation fails; in that case `deeplink`
is empty, `wallet_request` is omitted, and agents must not tell the user to send the
transaction. Decompiled or selector-only writes set `risk_level: "high"` and
require explicit human confirmation of selector + intent.

---

## 3. The verb surface (face-agnostic)

Seven verbs. Each lists inputs → output and the verb-specific error cases (all
share the Section 7 base errors).

| Verb | Inputs | Output | Notes |
|------|--------|--------|-------|
| `resolve_abi` | `chain, address` | `AbiResult` (2.4) | Runs the full ladder (Section 8). The other verbs call this internally. |
| `read_contract` | `Call` (no `from`) | `{ decoded, raw, function_signature }` | View/pure only; rejects state-mutating fns with `NOT_A_VIEW_FN`; `function_signature` is canonical (`balanceOf(address)`). |
| `encode_call` | `Call` (no `from`) | `{ data: "0x…", function_signature }` | Pure ABI encode; no chain round-trip needed once ABI is known. |
| `simulate` | `chain, from, to, data, value` **or** a `Call` | `Simulation` (2.6) | Raw-calldata form *or* high-level form (it encodes first); mixed forms are rejected. |
| `prepare_tx` | `Call` (with `from`) | `PreparedTx` (2.8) | Write/payable only; rejects view/pure fns with `NOT_A_WRITE_FN`; resolve → encode → simulate → summarize → hand-off. |
| `decode_tx` | `chain, tx_hash` | decoded calldata + (best-effort) trace + optional `decoded_call` | The "explain this tx" verb; heimdall rung = gulltoppr `/v1/decode`, enriched with resolved target ABI when available. |
| `resolve_name` | `name` *or* `address`, `chain?` | `{ address?, name? }` | ENS + Basenames, both directions. Non-mainnet chains use ENS coin-type resolution. |

Canonical agent workflow (the Skill teaches this):
`resolve_abi` → **check `provenance`** → `read_contract` (inspect) or `prepare_tx`
(write) → present `human_summary` + `simulation` → user signs via `deeplink` or
`wallet_request` when safety recommends signing.

---

## 4. REST contract

Base: `https://api.gulltoppr.dev/v1` for versioned contract verbs. Root discovery,
OpenAPI, health, and LLM guide endpoints live at the API origin without the `/v1`
prefix. JSON in/out, UTF-8.
`chain` is always a path segment so URLs are cache-key-friendly and CDN-shardable.

| Verb | Method + path | Body / query |
|------|---------------|--------------|
| discovery | `GET /` | REST/MCP links, core verbs, utility tools, and the `prepare_tx` safety gate |
| health | `GET /health` | Basic process health |
| REST contract | `GET /openapi.json` | OpenAPI 3.1 document for coding agents and integrations |
| agent guide | `GET /llms.txt` | Compact LLM/coding-agent guide |
| `resolve_abi` | `GET /v1/{chain}/{address}/abi` | `include_abi?` (default true), `method_q?`, `method_kind?`, `method_limit?` |
| `read_contract` | `POST /v1/{chain}/{address}/read` | `{ function, args }` |
| `encode_call` | `POST /v1/{chain}/{address}/encode` | `{ function, args, value? }` |
| `simulate` | `POST /v1/{chain}/simulate` | `{ from, to, data, value? }` or `{ from, address, function, args, value? }`; never both forms |
| `prepare_tx` | `POST /v1/{chain}/{address}/prepare` | `{ function, args, from, value? }` |
| `decode_tx` | `GET /v1/{chain}/tx/{hash}` | · |
| `resolve_name` | `GET /v1/{chain}/name/{name}` and `GET /v1/{chain}/name/by-address/{address}` | · |
| chain catalog | `GET /v1/chains` | `q?`, `testnets?`, `has_default_rpc?` |
| selector lookup | `GET /v1/lookup/{selector}` | 4-byte selector or 32-byte event topic0 |
| registry stats | `GET /v1/registry/stats` | Selector commons and bytecode index counts |
| registry export | `GET /v1/registry/export` | CC0 NDJSON selector commons |
| runtime metrics | `GET /v1/metrics` | Process-local rung/RPC latency and failure counters |

Conventions:
- **Provenance also surfaces as headers** on `…/abi` (mirrors gulltoppr's
  `X-Source`/`X-Cache`/`X-Elapsed-Ms`): `X-Source`, `X-Confidence`, `X-Cache`,
  `X-Elapsed-Ms`, plus `X-ABI-Included` to show whether the raw JSON ABI was
  returned or omitted.
- `?rpc_url=` optional override on read paths (defaults to the API's configured
  RPC per chain); required for chains the API has no default RPC for (e.g. 31337).
- `method_q`, `method_kind=read|write|all`, and `method_limit` filter only the
  returned capability manifest; use them with `include_abi=false` for large ABIs.
- Standard HTTP status mapping per Section 7.
- `GET` responses are cacheable; `Cache-Control` reflects provenance (verified
  ABIs cache long; decompiled shorter; tx decode is immutable → `immutable`).
  Operational endpoints (`/health`, `/v1/metrics`) are `no-store`; chain catalog
  is `max-age=3600`; registry lookup/export is `max-age=300`; name resolution is
  `max-age=60`; ABI responses are `86400` seconds for verified, `3600` for
  partial/decompiled/selector-only, and `300` behind proxies. The registry export
  is NDJSON with explicit CC0-1.0 license metadata in response headers.
- Rate-limited routes return `RateLimit-Limit`, `RateLimit-Remaining`, and
  `RateLimit-Reset`; `RATE_LIMITED` responses also include `Retry-After`.
- Engine result caches are scoped by `(chain id, resolved RPC URL hash, address/tx)`
  so `rpc_url` overrides for private forks or local chains cannot reuse results from
  a different endpoint with the same EIP-155 id.
- Runtime metrics use stable bucket names for the resolver ladder:
  `rung.etherscan`, `rung.sourcify`, `rung.proxy_detection`,
  `rung.heimdall`, `rung.4byte`, and public fallback lookups under
  `rung.4byte.directory`; RPC calls use `rpc.*` buckets.

---

## 5. MCP server contract

Thin adapter: one MCP tool per core verb, plus read-only utility tools for chains,
selector commons, and runtime metrics. Each core verb tool's `inputSchema` is the
verb's input type (Section 3 / 2.5); output is the verb's output type as the tool
result. JSON MCP tools expose `outputSchema` and `structuredContent` so clients can
branch on typed objects instead of scraping text; `export_registry` is the
intentional exception because it returns bulk CC0 NDJSON. Tools are
**read-only-annotated** except `prepare_tx` (which still signs nothing; annotate as
non-destructive, returns a hand-off).

| MCP tool | Wraps | One-line description (shown to the model) |
|----------|-------|--------------------------------------------|
| `resolve_abi` | §3 | Resolve a contract's ABI from chain+address via the fallback ladder; returns a compact manifest + provenance + proxy chain. **Always read `provenance` before acting.** |
| `read_contract` | §3 | Call a view/pure function and get the decoded result. No wallet needed. |
| `encode_call` | §3 | Encode a function call to calldata. |
| `simulate` | §3 | Simulate a tx and return gas, state diff, asset changes, and decoded effects. |
| `prepare_tx` | §3 | Prepare an **unsigned** tx + simulation + human summary + signing hand-off. The agent never signs; hand off only when safety recommends signing. |
| `decode_tx` | §3 | Explain what a transaction did: decoded calldata (+ trace when available). |
| `resolve_name` | §3 | Resolve ENS / basename ⇄ address. |
| `list_chains` | §4/§6 | List chain aliases and default RPC availability; use before asking a user for `rpc_url`. |
| `lookup_selector` | §4/§8 | Lookup proven signatures for a selector or event topic in the selector commons. |
| `registry_stats` | §4/§8 | Return selector commons and bytecode index counts. |
| `export_registry` | §4/§8 | Return the CC0 selector commons export. |
| `runtime_metrics` | §4 | Return process-local resolver/RPC latency and failure counters. |

MCP-specific guidance baked into the server's tool descriptions:
- `prepare_tx` description must state the hand-off model explicitly so models don't
  hallucinate a signing step. Agents must branch on structured `safety` before
  presenting a hand-off.
- `resolve_abi` omits the raw ABI in MCP output by default; the manifest,
  provenance, proxy, token metadata, and `abi_for` are the agent-facing surface.
- For JSON MCP tools, MCP exposes the returned REST object as `structuredContent`
  with an output schema. This includes `resolve_abi`, core execution verbs, chain
  catalog, selector lookup, registry stats, and runtime metrics.
- When provenance is partial, decompiled, selector-only, bytecode-matched, or
  proxy-resolved, the tool result leads with a `WARNING` before the JSON so the
  risk is salient in the model's context.

---

## 6. Chains

`chain` accepts an EIP-155 id or an alias. The API exposes `GET /v1/chains`, a
`viem/chains`-backed catalog for UI clients. The catalog includes `{ id, name,
aliases, testnet, has_default_rpc, default_rpc_url?, native_currency,
block_explorer_url? }`.

Catalog filters:
- `q`: case-insensitive match over id, name, aliases, and native symbol; multi-word
  queries also match token-by-token and whitespace-insensitive forms.
- `testnets`: `true` for only testnets/local/dev chains, `false` to exclude them.
- `has_default_rpc`: `true` for chains gulltoppr can use without `rpc_url`,
  `false` for chains that require a caller-supplied `rpc_url`.

| alias | id | default RPC source |
|-------|----|--------------------|
| `ethereum` / `mainnet` | 1 | publicnode |
| `base` | 8453 | publicnode |
| `optimism` | 10 | publicnode |
| `arbitrum` | 42161 | publicnode |
| `polygon` | 137 | publicnode |
| `monad` / `monad-mainnet` | 143 | Monad public RPC |
| `monad-testnet` / `monadtestnet` | 10143 | Monad public RPC |
| `local` | 31337 | **none · caller must pass `rpc_url`** |

Unknown chain id with no `rpc_url` → `UNKNOWN_CHAIN`. Known `viem/chains` ids use
their catalog default RPC unless gulltoppr overrides it with a more reliable public
endpoint. ENS/Basenames resolution starts from mainnet ENS; non-mainnet name routes
pass `toCoinType(chainId)` into viem's Universal Resolver calls, so
`/v1/base/name/{name}` resolves Base/Basenames records.

---

## 7. Error model

Stable machine codes, mapped to HTTP status (REST) and to MCP `isError` results
with the same `code` in the payload. Shape:
```jsonc
{ "error": { "code": "DECOMPILE_FAILED", "message": "human text", "details": {…}? } }
```

| code | HTTP | meaning |
|------|------|---------|
| `INVALID_ADDRESS` | 400 | malformed address/tx hash |
| `INVALID_ARGS` | 400 | args don't match the function's types |
| `UNKNOWN_CHAIN` | 400 | chain id/alias unknown and no `rpc_url` |
| `AMBIGUOUS_FUNCTION` | 400 | overloaded name; `details.candidates` lists signatures |
| `FUNCTION_NOT_FOUND` | 404 | no such function in the resolved ABI |
| `NOT_A_VIEW_FN` | 400 | `read_contract` called on a state-mutating fn |
| `NOT_A_WRITE_FN` | 400 | `prepare_tx` called on a view/pure fn |
| `ABI_NOT_FOUND` | 422 | ladder exhausted · no ABI from any rung (incl. no bytecode) |
| `DECOMPILE_FAILED` | 502 | gulltoppr/heimdall failed on the bytecode |
| `SIMULATION_REVERTED` | 200 | *not an error* · returned as `Simulation{success:false}` with decoded revert |
| `RPC_ERROR` | 502 | upstream RPC failed/unreachable |
| `UPSTREAM_TIMEOUT` | 504 | a rung (esp. decompile) exceeded its deadline |
| `RATE_LIMITED` | 429 | API or upstream throttle |

Note: a *reverted simulation* is a successful API response, not an error; the
agent needs the decoded revert reason to reason about it.

---

## 8. Resolution ladder (how `resolve_abi` produces provenance)

The moat. First rung that yields a usable ABI wins; provenance records which.

1. **Etherscan v2** (multichain, one key) → verified source/ABI.
   `confidence: verified`, `natspec` if present. The shared key is protected by a
   per-process fixed-window budget (`ETHERSCAN_RATE_LIMIT` /
   `ETHERSCAN_RATE_WINDOW_SEC`); when exhausted, this rung returns a miss and the
   ladder continues to Sourcify instead of failing the request.
2. **Sourcify** → verified fallback. `confidence: verified` (full match) /
   `partial` (partial match).
3. **Proxy detection** (EIP-1967 / UUPS / transparent / beacon / diamond / minimal
   1167) → for classic proxies, read implementation slot(s), **recurse** the ladder
   on the impl, and return its ABI tagged with the `ProxyChain`. For EIP-2535
   diamonds, call the standard loupe `facets()`, resolve each facet through the
   same source/decompile/selector ladder, and merge only functions whose selectors
   are active on that facet; `proxy.hops` lists facets, `resolved_implementation`
   is absent, and `abi_for` remains the queried diamond address. Confidence is
   capped behind a proxy and may degrade to `decompiled` / `selector-only` if any
   included facet ABI comes from those rungs.
4. **Bytecode-match reuse** → if the metadata-stripped runtime bytecode skeleton
   already exists in the local commons, reuse that ABI without re-running upstream
   fetches. The response is tagged with `source: "bytecode-match"`,
   `verified: false`, and `provenance.bytecode_match` so callers can inspect the
   original chain/address/source/confidence. Verified originals are capped to
   `partial` for this address; decompiled originals stay `decompiled`.
5. **heimdall decompile via gulltoppr** → `GET https://heimdall-api.fly.dev/v1/{address}?rpc_url=…`.
   gulltoppr returns `{ address, source:"heimdall-decompiled", cached, elapsed_ms, abi }`.
   Map to `confidence: decompiled`, `names_synthetic: true`, note about synthetic
   names. The engine caps outbound gulltoppr calls per process
   (`HEIMDALL_CONCURRENCY`, default `2`) and fails queued work after
   `HEIMDALL_QUEUE_TIMEOUT_MS` so decompile bursts cannot pin every worker.
   **This rung is why we resolve unverified contracts at all.**
6. **4byte / selector DB** → last resort, per-function only. The local selector
   commons is checked first and accepts only entries whose canonical signature
   locally hashes back to the selector/topic. Public 4byte.directory names are
   also locally selector-matched, but remain fallback labels, never proof.
   `confidence: selector-only`; no full ABI, only the signatures matched by selector.

`decode_tx` uses the same gulltoppr service:
`GET https://heimdall-api.fly.dev/v1/decode/{tx_hash}?rpc_url=…`
When the transaction target has a resolvable ABI, the engine also returns
`decoded_call` with `{ to, function, signature, args, abi_for, provenance }` from
the same resolution ladder used by `resolve_abi`.
(`source: "heimdall-decoded"`), layered over Etherscan/Sourcify ABI when the `to`
contract is verified (so events/params get real names).

gulltoppr operational notes that constrain this layer (see `gulltoppr-service`
memory + its `CLAUDE.md`): the engine has an outbound concurrency cap, but the
separate gulltoppr service may still need its own service-side cap if real load
shows VM memory pressure; trust the pinned `HEIMDALL_VERSION` in `/health`, not
`heimdall --version`.

---

## 9. Hand-off write flow (non-custodial)

```
agent → prepare_tx(Call w/ from)
        → { unsigned_tx, simulation, human_summary, deeplink, wallet_request?, warnings, safety }
agent → checks safety.signing_recommended
agent → presents human_summary + simulation.asset_changes/state_diff + warnings
user  → opens deeplink or wallet_request only when signing_recommended=true
user  → connects wallet, reviews, signs, broadcasts
```
`SIGNING_BASE_URL` controls the optional shareable signing deeplink; the default
deployment points it at abi.ninja because prefilled URLs and unfurling already
exist there. Zero wallet custody or broadcast infra. `wallet_request` is a
convenience payload for integrations that already own wallet connection; gulltoppr
still never signs or broadcasts. Session keys / ERC-4337 / 7702 are explicitly
**out of v1**.

---

## 10. Versioning & non-goals

- REST is versioned in-path (`/v1`). MCP tool names are unversioned but additive;
  breaking a tool's schema requires a new tool name.
- **Non-goals (v1):** custodial signing; broadcasting txs; private-key handling;
  multi-step "agent autonomously executes" flows; write simulation without a `from`.
- gulltoppr stays a separate service with its own lifecycle; this API depends on its
  HTTP contract, not its internals.

---

## 11. Open items (carry into build)

- **Simulation backend: DECIDED, raw `eth_call`/`debug_traceCall`, no Tenderly**
  (keyless, any-chain incl. 31337). `state_diff` is best-effort from
  `prestateTracer` diff mode; logs and token effects are best-effort from
  `callTracer` (§2.6). Many public RPCs do not expose `debug_traceCall`, so
  unsupported traces degrade to empty arrays.
- **gulltoppr service-side concurrency cap:** the engine caps outbound rung-4
  work, but the separate gulltoppr deployment may still need an internal cap if
  real load shows memory pressure inside that service.
- **Build order (from IDEATION.md):** REST engine (ladder + provenance) → MCP server
  + deeplink hand-off → SDK + Skill, then wallet/explorer/app integrations.
```
