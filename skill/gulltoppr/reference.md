# gulltoppr: reference

Full verb surface, chain table, error codes, and a worked example. Load this when
you need exact signatures or are debugging a call. The workflow and safety rules are
in `SKILL.md`.

## Verbs

| verb | inputs | returns |
|------|--------|---------|
| `resolve_abi` | `chain, address, include_abi?, method_q?, method_kind?, method_limit?` | `{ interface{reads,writes}, abi?, abi_omitted?, provenance, proxy?, token?, abi_for, cached }` |
| `read_contract` | `chain, address, function, args` | `{ decoded[], raw, function_signature }` · view/pure only |
| `encode_call` | `chain, address, function, args, value?` | `{ data, function_signature }` |
| `simulate` | `chain, from, {address,function,args} \| {to,data}, value?` | `Simulation` |
| `prepare_tx` | `chain, address, function, args, from, value?` | `{ unsigned_tx, simulation, human_summary, deeplink, wallet_request?, warnings, safety }` |
| `decode_tx` | `chain, tx_hash` | `{ source, cached, decoded, provenance, decoded_call? }` |
| `resolve_name` | `name` (ENS/Basename or 0x address), chain? | `{ address?, name? }` |
| `list_chains` | `q?, testnets?, has_default_rpc?` | `{ chains[] }` with `testnet` and `has_default_rpc` flags |
| `lookup_selector` | `selector` | `{ selector, entries[] }`; entries include `proof` and may include source `chain`/`address` |
| `registry_stats` | none | `{ selectors, bytecodes }` |
| `export_registry` | none | CC0 selector commons NDJSON |
| `runtime_metrics` | none | process-local resolver/RPC counters |

- `function` is a bare name, or a full signature like `transfer(address,uint256)`
  when the name is overloaded (else you get `AMBIGUOUS_FUNCTION` with candidates).
- Numbers come back as decimal **strings** (bigints serialized for the wire).
- `provenance.confidence`: `verified` > `partial` > `decompiled` > `selector-only`.
- `provenance.bytecode_match?`: `{ chain, address, source, confidence }` when
  identical metadata-stripped runtime bytecode supplied a reused ABI.
- MCP `resolve_abi` omits raw `abi` by default and marks `abi_omitted: true`; REST
  and SDK callers can pass `include_abi=false` / `resolveManifest()` for the same
  token-efficient shape. MCP `resolve_abi` leads with a `WARNING` for partial,
  proxy, bytecode-match, decompiled, or selector-only provenance. JSON MCP tools
  expose output schemas and structured content when the MCP client supports it;
  use those objects instead of parsing JSON text. `export_registry` remains NDJSON
  text for bulk export.
- For large ABIs, filter the returned manifest with `method_q`,
  `method_kind=read|write|all`, and `method_limit` before putting methods in model
  context.
- `decode_tx.decoded` is the delegated heimdall explanation. If the target ABI
  resolves, `decoded_call` adds typed calldata `{ function, signature, args }` with
  its own ABI provenance.

## Simulation shape

Use either the high-level form `{ address, function, args }` or the raw form
`{ to, data }`, never both in one request.

```jsonc
{
  "success": true,
  "gas_used": 46434,
  "return_value": { "decoded": [], "raw": "0x…01" },
  "asset_changes": [ { "address": "0x…", "token": "0x…", "delta": "-1000000", "kind": "erc20" } ],
  "state_diff": [ { "address": "0x…", "slot_label": "0x…", "before": "0x…", "after": "0x…" } ],
  "logs": [ { "address": "0x…", "event": "Transfer(address,address,uint256)", "args": {…} } ],
  "revert": { "reason": "…" }  // present only when success=false
}
```
`success`, `gas_used`, and `revert` are exact. `asset_changes`/`logs` and
`state_diff` need a tracing RPC; unsupported public RPCs return empty arrays. So
absence of asset_changes or state_diff ≠ "no effects."

## Prepared transaction safety

`prepare_tx.safety` is the agent gate before hand-off:

```jsonc
{
  "signing_recommended": true,
  "risk_level": "low",       // low | medium | high | blocked
  "requires_human_confirmation": false,
  "reasons": []              // abi_names_inferred | proxy | simulation_failed | native_value | spending_approval | asset_outflow
}
```

Only present `deeplink` or `wallet_request` as a signing hand-off when
`signing_recommended` is true. `wallet_request` is an EIP-1193-shaped
`eth_sendTransaction` request with hex JSON-RPC quantities for wallet/app
integrations. `risk_level: "high"` means decompiled/selector-only ABI names or
mutability may be inferred and the user must confirm selector + intent.
`risk_level: "blocked"` means the simulation failed; do not send.
`spending_approval` means a spender/operator
gets token or NFT transfer rights. `asset_outflow` means trace-derived effects or
standard token/NFT transfer intent show ERC20, ERC721, or ERC1155 value leaving the
transfer source. Show either risk before hand-off.

## Chains

Alias or numeric id: `ethereum`/`mainnet` (1), `base` (8453), `optimism` (10),
`arbitrum` (42161), `polygon` (137), `monad`/`monad-mainnet` (143),
`monad-testnet`/`monadtestnet` (10143), `local` (31337, **pass `rpcUrl`**). Any
other id works if you pass `rpcUrl`. ENS/Basenames resolution starts from mainnet
ENS; pass `chain: "base"` for Basenames so the Base coin type is used.
`list_chains.q` searches ids, names, aliases, and native symbols; multi-word
queries match token-by-token and without whitespace.

## Error codes

`INVALID_ADDRESS`, `INVALID_ARGS`, `UNKNOWN_CHAIN`, `AMBIGUOUS_FUNCTION`
(`details.candidates`), `FUNCTION_NOT_FOUND`, `NOT_A_VIEW_FN` (called a write via
`read_contract`), `NOT_A_WRITE_FN` (called a read via `prepare_tx`),
`ABI_NOT_FOUND` (EOA, or ladder exhausted), `DECOMPILE_FAILED`, `RPC_ERROR`,
`UPSTREAM_TIMEOUT`, `RATE_LIMITED`. A *reverting simulation* is NOT an error; it
returns `Simulation{ success:false, revert }`.

## Worked example: "approve 100 USDC for the Uniswap router on Base"

```
1. resolve_abi("base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")
   → provenance.confidence = "verified", token = { erc20, symbol: "USDC", decimals: 6 }
   → interface.writes includes approve(address,uint256)

2. provenance verified ⇒ names trustworthy. Amount: 100 USDC, 6 decimals ⇒ "100000000".

3. prepare_tx(
     "base", "0x8335…2913", "approve",
     ["0x2626664c2603336E57B271c5C0b26F421741e481", "100000000"],
     from = "0xUserWallet…"
   )
   → unsigned_tx.data = "0x095ea7b3…", simulation.success = true,
     human_summary = "Call approve(…) on 0x8335…2913.",
     deeplink = "https://abi.ninja/8453/0x8335…2913?function=approve&args=…",
     wallet_request.method = "eth_sendTransaction",
     warnings = [], safety.signing_recommended = true

4. Show the user the summary + simulated gas + (empty) warnings, then hand over the
   deeplink or wallet request. They connect their wallet and sign. You are done;
   you do NOT sign.
```

If step 1 had returned `confidence: "decompiled"`, you would instead tell the user
"this contract is unverified; the function I'm calling is named `approve` but that
name was inferred by decompilation; please confirm selector and intent before
signing." If simulation failed, `safety.signing_recommended` would be false, the
deeplink would be empty, and `wallet_request` would be omitted.
