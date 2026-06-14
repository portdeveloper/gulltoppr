# gulltoppr: reference

Full verb surface, chain table, error codes, and a worked example. Load this when
you need exact signatures or are debugging a call. The workflow and safety rules are
in `SKILL.md`.

## Verbs

| verb | inputs | returns |
|------|--------|---------|
| `resolve_abi` | `chain, address` | `{ interface{reads,writes}, abi, provenance, proxy?, token?, abi_for, cached }` |
| `read_contract` | `chain, address, function, args` | `{ decoded[], raw, function_signature }` · view/pure only |
| `encode_call` | `chain, address, function, args, value?` | `{ data, function_signature }` |
| `simulate` | `chain, from, {address,function,args} \| {to,data}, value?` | `Simulation` |
| `prepare_tx` | `chain, address, function, args, from, value?` | `{ unsigned_tx, simulation, human_summary, deeplink, warnings }` |
| `decode_tx` | `chain, tx_hash` | `{ source, cached, decoded, provenance }` |
| `resolve_name` | `name` (ENS or 0x address) | `{ address?, name? }` |

- `function` is a bare name, or a full signature like `transfer(address,uint256)`
  when the name is overloaded (else you get `AMBIGUOUS_FUNCTION` with candidates).
- Numbers come back as decimal **strings** (bigints serialized for the wire).
- `provenance.confidence`: `verified` > `partial` > `decompiled` > `selector-only`.

## Simulation shape

```jsonc
{
  "success": true,
  "gas_used": 46434,
  "return_value": { "decoded": [], "raw": "0x…01" },
  "asset_changes": [ { "address": "0x…", "token": "0x…", "delta": "-1000000", "kind": "erc20" } ],
  "state_diff": [],            // best-effort; empty unless the RPC supports debug_traceCall
  "logs": [ { "address": "0x…", "event": "Transfer(address,address,uint256)", "args": {…} } ],
  "revert": { "reason": "…" }  // present only when success=false
}
```
`success`, `gas_used`, and `revert` are exact. `asset_changes`/`logs` need a tracing
RPC; `state_diff` is not yet populated. So absence of asset_changes ≠ "no transfers."

## Chains

Alias or numeric id: `ethereum`/`mainnet` (1), `base` (8453), `optimism` (10),
`arbitrum` (42161), `polygon` (137), `monad`/`monad-mainnet` (143),
`monad-testnet`/`monadtestnet` (10143), `local` (31337, **pass `rpcUrl`**). Any
other id works if you pass `rpcUrl`. ENS resolves on mainnet.

## Error codes

`INVALID_ADDRESS`, `INVALID_ARGS`, `UNKNOWN_CHAIN`, `AMBIGUOUS_FUNCTION`
(`details.candidates`), `FUNCTION_NOT_FOUND`, `NOT_A_VIEW_FN` (called a write via
`read_contract`), `ABI_NOT_FOUND` (EOA, or ladder exhausted), `DECOMPILE_FAILED`,
`RPC_ERROR`, `UPSTREAM_TIMEOUT`, `RATE_LIMITED`. A *reverting simulation* is NOT an
error; it returns `Simulation{ success:false, revert }`.

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
     warnings = []

4. Show the user the summary + simulated gas + (empty) warnings, then hand over the
   deeplink. They connect their wallet on abi.ninja and sign. You are done; you do
   NOT sign.
```

If step 1 had returned `confidence: "decompiled"`, you would instead tell the user
"this contract is unverified; the function I'm calling is named `approve` but that
name was inferred by decompilation; please confirm before signing," and still hand
off the same way.
