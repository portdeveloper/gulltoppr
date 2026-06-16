---
name: gulltoppr
description: >-
  Interact with any smart contract on any EVM chain: resolve its ABI (even for
  UNVERIFIED contracts, via heimdall decompilation), read on-chain state, or prepare
  a safe, simulated, ready-to-sign transaction for the user. Use whenever someone
  wants to call, read, query, inspect, or transact with a contract by address, e.g.
  "what's the USDC balance of 0x…", "approve the router to spend my tokens", "what
  can this contract do", "what did this transaction do", or resolving an ENS name.
  Non-custodial: this never signs or sends; it hands the user a tx to sign.
---

# gulltoppr: interacting with smart contracts

This skill turns "(chain, address) + intent" into a correct on-chain read or a
**safe, simulated, ready-to-sign transaction**. The engine resolves an ABI even when
the contract is unverified, so you are not limited to Etherscan-verified contracts.

## The one rule that matters: you never sign

You do **not** have the user's keys and you never sign or broadcast. The write path
ends at an *unsigned* transaction + a simulation + a human summary + a
**configured signing deeplink or EIP-1193 wallet request when signing is
recommended**. You present that to the user; they sign in their own wallet. Never
claim a transaction was sent. Never ask for a private key or seed phrase.

## The workflow

Always follow this order. Do not skip step 2.

1. **Resolve**: `resolve_abi(chain, address)`. Returns a capability manifest
   (`interface.reads` / `interface.writes`, "the buttons"), `provenance`, a `proxy`
   chain if any, and `token` metadata. The manifest, not the raw ABI, is what you
   reason over and show the user. MCP output omits the raw ABI to save tokens; use
   the REST/SDK raw ABI only when you need to run your own ABI tooling.
   MCP `resolve_abi` leads with a `WARNING` before the JSON when provenance is
   partial, decompiled, selector-only, bytecode-matched, or proxy-resolved.
   When the MCP client exposes structured content, read structured `provenance`,
   `proxy`, `token`, `interface`, `simulation`, selector results, metrics, and
   `safety` rather than parsing warning or JSON text.
   For large contracts, filter before loading methods into context with `method_q`,
   `method_kind`, and `method_limit`.

2. **Check provenance, ALWAYS.** Read `provenance.confidence`:
   - `verified`: real names + NatSpec. Trust the function/param names.
   - `partial`: verified-ish, but behind a proxy or partial match. Reasonable, but
     say so.
   - `decompiled`: **heimdall guessed the names** (`names_synthetic: true`). The ABI
     is usable but a function called `transfer` might be named `Unresolved_0x…` or
     mislabeled. Treat with care: cross-check the selector against what you expect,
     and tell the user the names are inferred before any write.
   - `selector-only`: only per-function selector matches; no full ABI.
   If `provenance.bytecode_match` is present, surface the matched original
   chain/address/source/confidence; the ABI was reused from identical
   metadata-stripped runtime bytecode, not verified at the queried address.
   Calibrate your confidence (and the user's) to this. This is the whole point.

3. **Act:**
   - **Read** (view/pure): `read_contract(chain, address, fn, args)`. No wallet,
     no cost. Returns the decoded value.
   - **Write** (mutating): `prepare_tx(chain, address, fn, args, from)`. This
     resolves, encodes, **simulates**, and returns an unsigned tx + simulation +
     `human_summary` + `deeplink` + optional `wallet_request` + `warnings` +
     `safety`.

4. **Present & hand off** (writes): show the user the `human_summary`, the simulated
   effects (`simulation.asset_changes` / `state_diff` / `gas_used`), and **every**
   item in `warnings`. Check `safety` before hand-off. Only give them the `deeplink`
   or `wallet_request` when `safety.signing_recommended` is true. If
   `simulation.success` is false or `safety.risk_level` is `blocked`, the tx **will
   revert**; do not tell the user to send it; explain why it reverts
   (`simulation.revert.reason`).

Other verbs: `decode_tx(chain, hash)` ("what did this tx do?"),
`resolve_name(name, chain?)` (ENS/Basenames ⇄ address). Utility MCP tools:
`list_chains`, `lookup_selector`, `registry_stats`, `export_registry`, and
`runtime_metrics`.

## How to call it

**If the `gulltoppr` MCP server is connected** (preferred for an agent): call the
tools `resolve_abi`, `read_contract`, `encode_call`, `simulate`, `prepare_tx`,
`decode_tx`, `resolve_name` directly. Use `list_chains` before resolving when the
chain alias or `rpc_url` requirement is unclear.

**If you're writing code / building an app**: use the `gulltoppr` client.

```ts
import { Gulltoppr, requireWalletRequest } from "gulltoppr";
const gulltoppr = new Gulltoppr({ baseUrl: "https://api.gulltoppr.dev" });

const r = await gulltoppr.resolveManifest("base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", {
  q: "balance approve transfer",
  kind: "all",
  limit: 20,
});
if (r.provenance.names_synthetic) { /* warn the user: names are inferred */ }

const { decoded } = await gulltoppr.read("base", r.address, "balanceOf", ["0xUser…"]);

const prep = await gulltoppr.prepareTx("base", r.address, "transfer", ["0xTo…", "1000000"], {
  from: "0xUser…",
});
// → show prep.human_summary + prep.simulation + prep.warnings, then hand over
//   prep.deeplink or requireWalletRequest(prep) only if safety allows signing
```

## Critical habits

- **Amounts are in base units.** A token with 6 decimals: 1.5 USDC = `"1500000"`,
  not `"1.5"`. Use `token.decimals` and the per-function `hint`. Get this wrong and
  the user sends the wrong amount.
- **Proxies**: a classic proxy's ABI is resolved against its *implementation*
  (`abi_for` ≠ `address`, `proxy` is populated). EIP-2535 diamonds return a merged
  facet ABI with `abi_for = address` and facet hops in `proxy.hops`. Confidence is
  capped behind a proxy.
- **Decompiled ⇒ hedge.** Lead with the warning, never present a synthetic name as
  ground truth. Treat `prepare_tx.safety.risk_level = "high"` as requiring explicit
  user confirmation of the function selector and intent.
- **Spender approvals ⇒ confirm.** If `prepare_tx.safety.reasons` includes
  `spending_approval`, tell the user which spender/operator gains token or NFT
  transfer rights before handing off a signing request.
- **Asset outflows ⇒ confirm.** If `prepare_tx.safety.reasons` includes
  `asset_outflow`, tell the user which token/NFT/native value leaves the transfer
  source before handing off a signing request.
- **Surface warnings verbatim.** `prepare_tx.warnings` exists so the user sees risk.
- **Pass `from`** for writes/simulations: it's the user's address (no key needed).
- **Names**: use `chain: "base"` for Basenames (`*.base.eth`) so chain-specific
  ENS coin-type resolution is used.
- **Local or unlisted EVM chains** (`local`/31337, custom networks): pass `rpcUrl`.
- **Overloads**: pass a full signature such as `transfer(address,uint256)` when a
  bare function name is ambiguous.

For the full verb signatures, chain table, error codes, and a worked end-to-end
example, see `reference.md`.
