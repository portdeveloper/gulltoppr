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
import { AbiNinja } from "gulltoppr";

// baseUrl defaults to the live engine; pass it only to override.
const ninja = new AbiNinja({ baseUrl: "https://api.gulltoppr.dev" });

// Resolve: ABI is secondary; the capability manifest + provenance are the point.
const r = await ninja.resolveAbi("base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
if (r.provenance.confidence === "decompiled") {
  console.warn("Decompiled ABI; names are inferred:", r.provenance.notes);
}
console.log(r.interface.reads.map((f) => f.signature));   // the "buttons"

// Read (no wallet)
const { decoded } = await ninja.read("base", r.address, "balanceOf", ["0xabc…"]);

// Prepare a write: returns an UNSIGNED tx + simulation + deeplink. Signs nothing.
const prep = await ninja.prepareTx("base", r.address, "transfer", ["0xdef…", "1000000"], {
  from: "0xMyWallet…",
});
console.log(prep.human_summary, prep.warnings);
// → hand prep.deeplink to the user; they sign in their own wallet.
```

### `contract()`: resolve once, then act (viem-flavoured)

```ts
const usdc = ninja.contract("base", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const meta = await usdc.resolve();              // memoized
const bal = await usdc.read("balanceOf", ["0xabc…"]);
const tx = await usdc.prepare("approve", ["0xspender…", "1000000"], { from: "0xme…" });
```

## API

| method | verb |
|--------|------|
| `resolveAbi(chain, address, opts?)` | resolve_abi |
| `read(chain, address, fn, args?, opts?)` | read_contract |
| `encode(chain, address, fn, args?, opts?)` | encode_call |
| `simulate(chain, { from, address/function/args \| to/data, value? }, opts?)` | simulate |
| `prepareTx(chain, address, fn, args, { from, value?, rpcUrl? })` | prepare_tx |
| `decodeTx(chain, txHash, opts?)` | decode_tx |
| `resolveName(nameOrAddress, chain?)` | resolve_name |
| `chains()` | chain catalog |
| `contract(chain, address)` | ergonomic handle |

- `chain` is an alias returned by `chains()` or a numeric id.
- `opts.rpcUrl` overrides the engine's RPC (required for `local`/31337 and any
  EVM chain without a built-in alias).
- Errors throw `AbiNinjaError` with a stable `.code` (`NOT_A_VIEW_FN`,
  `AMBIGUOUS_FUNCTION` with `.details.candidates`, `ABI_NOT_FOUND`, …) and `.status`.
- Bigints arrive as decimal strings (the engine serializes them on the wire).

## Build

```bash
npm run build       # tsc → dist/ (js + d.ts)
npm run typecheck
npm test            # vitest client tests with an injected fetch (no network)
```
