# 🐴 gulltoppr

Typed TypeScript client for the [gulltoppr](../README.md): resolve any
contract's ABI (verified *or* unverified, via the heimdall decompile rung) and
prepare safe, simulated, non-custodial interactions. The typed client over the REST
surface in [`../SPEC.md`](../SPEC.md) §4.

```bash
npm install gulltoppr viem
```

## Usage

```ts
import { Gulltoppr, requireLowRiskWalletRequest, requireWalletRequest, searchContractMethods } from "gulltoppr";

// baseUrl defaults to the live engine; pass it only to override.
const gulltoppr = new Gulltoppr({ baseUrl: "https://api.gulltoppr.dev" });

// Resolve: ABI is secondary; the capability manifest + provenance are the point.
const r = await gulltoppr.resolveAbi("base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
if (r.provenance.confidence === "decompiled") {
  console.warn("Decompiled ABI; names are inferred:", r.provenance.notes);
}
if (r.provenance.bytecode_match) {
  console.warn("ABI reused from matching bytecode:", r.provenance.bytecode_match);
}
console.log(r.interface.reads.map((f) => f.signature));   // the "buttons"

// Compact resolve for agent context: no raw JSON ABI.
const manifest = await gulltoppr.resolveManifest("base", r.address, { q: "transfer uint256", kind: "write", limit: 25 });
console.log(manifest.abi_omitted, manifest.interface.writes.length);
const matches = searchContractMethods(manifest.interface, { q: "transfer uint256", kind: "write", limit: 10 });
console.log(matches.map((match) => match.method.signature));

// Read (no wallet)
const { decoded } = await gulltoppr.read("base", r.address, "balanceOf", ["0xabc…"]);

// Prepare a write: returns an UNSIGNED tx + simulation + safety metadata. Signs nothing.
const prep = await gulltoppr.prepareTx("base", r.address, "transfer", ["0xdef…", "1000000"], {
  from: "0xMyWallet…",
});
console.log(prep.human_summary, prep.warnings, prep.safety);
// → hand prep.deeplink or prep.wallet_request to the user only when
//   prep.safety.signing_recommended is true.
const walletRequest = requireWalletRequest(prep); // throws if safety blocks signing
const lowRiskWalletRequest = requireLowRiskWalletRequest(prep); // also throws if human confirmation is required
```

### `contract()`: resolve once, then act (viem-flavoured)

```ts
const usdc = gulltoppr.contract("base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const meta = await usdc.resolve();              // memoized
const bal = await usdc.read("balanceOf", ["0xabc…"]);
const sim = await usdc.simulate("approve", ["0xspender…", "1000000"], { from: "0xme…" });
const tx = await usdc.prepare("approve", ["0xspender…", "1000000"], { from: "0xme…" });
```

## API

| method | verb |
|--------|------|
| `discovery()` | root discovery document: REST/MCP links, verbs, utility tools, safety gate |
| `resolveAbi(chain, address, opts?)` | resolve_abi |
| `resolveManifest(chain, address, opts?)` | resolve_abi with `include_abi=false` |
| `read(chain, address, fn, args?, opts?)` | read_contract |
| `encode(chain, address, fn, args?, opts?)` | encode_call |
| `simulate(chain, { from, address/function/args \| to/data, value? }, opts?)` | simulate |
| `prepareTx(chain, address, fn, args, { from, value?, rpcUrl? })` | prepare_tx |
| `decodeTx(chain, txHash, opts?)` | decode_tx |
| `resolveName(nameOrAddress, chain?)` | resolve_name (ENS/Basenames; use `"base"` for Basenames) |
| `chains({ q?, testnets?, hasDefaultRpc? })` | chain catalog |
| `metrics()` | runtime metrics |
| `lookupSelector(selector)` | selector commons lookup with proof grade and optional source chain/address |
| `registryStats()` | selector commons counts |
| `exportRegistry()` | CC0 selector commons export parsed from NDJSON |
| `contract(chain, address)` | ergonomic handle |
| `searchContractMethods(interface, { q?, kind?, limit? })` | local manifest method search |
| `filterContractInterface(interface, { q?, kind?, limit? })` | local manifest filter preserving `{reads,writes}` |
| `provenanceWarnings(result)` | resolve/manifest warnings for inferred ABIs, bytecode matches, proxies, and compact ABI omission |
| `isHighFrictionProvenance(provenance)` / `hasBytecodeMatch(provenance)` | typed provenance guards |
| `ENGINE_ERROR_CODES` | stable engine-originated error codes; SDK-only transport errors are `NETWORK` and `INTERNAL` |

`requireWalletRequest(preparedTx)` returns the EIP-1193 `wallet_request` only when
`preparedTx.safety.signing_recommended` is true; otherwise it throws before any
wallet call happens. `requireLowRiskWalletRequest(preparedTx)` is stricter: it also
throws when `risk_level` is not `"low"` or `requires_human_confirmation` is true
(for example spender approvals, asset outflows, proxies, native value, or inferred
ABI names).

- `chain` is an alias returned by `chains()` or a numeric id.
- Each `chains()` entry includes `testnet` and `has_default_rpc` so clients can
  decide when an RPC URL must be requested from the user.
- `chains({ q })` searches ids, names, aliases, and native symbols; multi-word
  queries match token-by-token and without whitespace.
- `opts.rpcUrl` overrides the engine's RPC (required for `local`/31337 and any
  EVM chain without a built-in alias).
- `resolveManifest()` is the token-efficient resolve path for agents; it omits raw
  JSON ABI and returns `abi_omitted: true`. Pass `{ q, kind, limit }` to filter
  large manifests server-side before they enter model context.
- `provenanceWarnings(resolved)` returns strings integrations should show for
  inferred names, bytecode-match ABI reuse, proxies, or compact ABI omission.
- `searchContractMethods()` and `filterContractInterface()` are local helpers for
  large ABIs; they search method names, signatures, parameter names/types, and hints
  without another network call.
- The SDK validates obvious identifier and call-shape errors (`address`, selector,
  transaction hash, `function`, `args`, decimal `value`, raw simulate `to`/`data`)
  before fetch and throws `AbiNinjaError("INVALID_ARGS")`; raw simulate
  `{ to, data }` and high-level `{ address, function, args }` forms are mutually
  exclusive.
- Errors throw `AbiNinjaError` with a stable `.code` (`NOT_A_VIEW_FN`, `NOT_A_WRITE_FN`,
  `AMBIGUOUS_FUNCTION` with `.details.candidates`, `ABI_NOT_FOUND`, …) and `.status`.
  `ENGINE_ERROR_CODES` lists the codes that can come from the engine envelope.
- Bigints arrive as decimal strings (the engine serializes them on the wire).
- `AbiNinja` remains exported as a backwards-compatible alias; prefer `Gulltoppr`
  in new code.

## Build

```bash
npm run build       # tsc → dist/ (js + d.ts)
npm run typecheck
npm test            # vitest client tests with an injected fetch (no network)
```
