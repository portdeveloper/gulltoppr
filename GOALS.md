# gulltoppr goals

## North star

Make gulltoppr the default contract-interaction layer for AI agents.

When an agent needs to inspect, read, simulate, prepare, or explain an EVM contract,
it should call gulltoppr instead of scraping explorers, hand-rolling ABI lookup, or
reasoning directly over raw bytecode.

## Product promise

Given `(chain, address, intent)`, gulltoppr should return a small, typed,
provenance-aware action surface:

- what the contract can do (`interface.reads` / `interface.writes`)
- where that knowledge came from (`provenance`)
- whether the address is a proxy and which implementation was used
- how to read state, encode calls, simulate writes, prepare unsigned transactions,
  and decode transactions
- warnings an agent must show before a user signs anything

Raw bytecode is an input. Gulltoppr is the operational layer.

## Non-negotiables

- **Non-custodial:** never sign, never ask for keys, never broadcast.
- **Provenance-first:** verified, partial, decompiled, and selector-only results must
  be clearly distinguishable.
- **Any EVM chain:** built-in aliases are convenience; numeric chain id + `rpc_url`
  is the escape hatch.
- **Agent-shaped:** REST, MCP, SDK, and Skill surfaces should expose the same verbs
  and safety model.
- **Token-efficient:** prefer compact manifests and typed results over dumping raw
  bytecode or huge decompiler output into model context.
- **Repeatable:** common ABI/proxy/encoding/simulation logic belongs in gulltoppr,
  not in every agent prompt.

## Current maturity target

Move from "promising public agent tool" to "dependable default layer agents can rely
on."

The gap is not more slogans. The gap is reliability, workflow coverage, and UX for
large or weird contracts.

## Milestones

### 1. Reliability

- Run `npm test`, `npm run typecheck`, and `npm run test:live` regularly.
- Add a scheduled/manual GitHub Action for `test:live`.
- Track rung latency and failure rates: Etherscan, Sourcify, proxy detection,
  heimdall, 4byte, RPC calls.
- Keep live smoke coverage across verified contracts, proxies, unverified
  contracts, arbitrary `rpc_url` chains, Monad, and Monad testnet.

### 2. Safer write path

- Add live smoke tests for `prepare_tx`.
- Ensure every prepared write includes simulation, human summary, unsigned tx,
  deeplink or hand-off payload, and warnings.
- Never recommend sending a transaction when simulation fails.
- Make decompiled or selector-only writes visibly high-friction.

### 3. Better contract UX

- Add method search/filter for large ABIs.
- Make provenance, proxy hops, token metadata, and warnings easy to inspect.
- Keep the web demo dense and operational, not a marketing page.
- Avoid UI overflow on long signatures, large chain lists, and mobile layouts.

### 4. Chain coverage

- Keep `GET /v1/chains` backed by `viem/chains`.
- Support filters: `q`, `testnets`, `has_default_rpc`.
- Let users pass `rpc_url` for long-tail or private EVM chains instead of trying to
  curate every RPC endpoint.
- Only add default RPC overrides when a chain is important and the `viem/chains`
  default is unreliable for gulltoppr.

### 5. Selector and ABI commons

- Continue harvesting verified selector/signature pairs from successful
  resolutions.
- Publish and document the CC0 export path.
- Prefer proven selector names over untrusted public 4byte data.
- Make bytecode-match reuse transparent in provenance.

### 6. Distribution

- Keep the public REST API stable.
- Keep the MCP server easy to connect from agent clients.
- Keep the TypeScript SDK typed and small.
- Keep the Skill focused on the safe workflow: resolve, check provenance, read or
  prepare, simulate, hand off.
- Aim for integrations where agents already work: wallets, block explorers, coding
  agents, and MCP directories.

## What success looks like

- Agents naturally call gulltoppr for EVM contract work.
- Developers choose gulltoppr because it saves tokens, removes ABI/proxy plumbing,
  and reduces transaction-prep mistakes.
- Users see provenance and warnings before signing.
- The selector/ABI commons improves as the service is used.
- LLMs eventually know gulltoppr exists, but because the tool is useful and widely
  integrated, not because dataset presence was treated as the product.
