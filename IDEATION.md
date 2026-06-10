# abi.ninja for agents — architecture ideation

> Goal: let AI agents interact with any smart contract on any EVM chain as easily
> as a human uses abi.ninja today. The world went agentic; people ask their agents
> to "do stuff" onchain. We give agents the same superpower abi.ninja gives humans.

## The core insight

abi.ninja's real value isn't the UI — it's the **resolution layer**: give it a
chain + address and it figures out the ABI and exposes a universal calling surface.
Agents can call an LLM all day but can't reliably go from "the USDC contract on Base"
to a correctly-encoded, simulated, safe transaction. That's the moat, repackaged.

The biggest differentiator: with **heimdall-rs** (decompilation) in the resolution
ladder, we produce a usable ABI **even for unverified contracts**. Most agent tools
die the moment a contract isn't on Etherscan. Ours won't.

## Decisions (from ideation)

- **Write model:** hand-off to the user's wallet. The agent never signs. We resolve,
  read, encode, simulate, and prepare an unsigned tx + human-readable summary; the
  user approves in their own wallet. Non-custodial, matches abi.ninja's ethos.
  (Design toward session keys / ERC-4337/7702 later, but not v1.)
- **Surfaces:** all four — REST API (the engine), MCP server (headline agent product),
  Claude Skill (workflow guide), npm SDK (typed client + refactor frontend onto it).
- **Existing stack:** abi.ninja is frontend-only (Next.js / Scaffold-ETH 2, in
  `packages/nextjs`). Resolution is split: Etherscan v2 + proxy detection + ENS live
  client-side; **heimdall runs as a separate backend service ("gulltoppr")** the
  frontend calls.

## Step 0 — extract a headless resolution engine

Pull the resolver out of the React app into a standalone service (the REST API).
One core capability with a **fallback ladder** — the ladder *is* the product:

```
resolve(chain, address):
  1. Etherscan v2 verified source/ABI      → best: real names, NatSpec
  2. Sourcify                               → verified fallback
  3. proxy detection (1967/UUPS/diamond)    → recurse into implementation
  4. heimdall-rs decompile (gulltoppr)      → UNVERIFIED contracts ← the moat
  5. 4byte / selector DB                    → last resort, per-function
  → returns: ABI + source/confidence tag + proxy chain + token metadata
```

**Provenance is first-class.** Every result carries a `source` + `confidence` tag so
an agent knows "decompiled by heimdall, names may be `Unresolved_0x...`, treat with
care" vs. "verified, NatSpec available." This is the difference between an agent
confidently sending a wrong tx and one that hedges correctly. Never hide provenance.

## The verb surface (shared by all four faces)

```
resolve_abi(chain, address)                 → ABI + provenance + proxy chain
read_contract(chain, address, fn, args)     → decoded result (no keys)
encode_call(chain, address, fn, args)       → calldata
simulate(chain, from, to, calldata, value)  → gas + state diff + decoded effects
prepare_tx(chain, address, fn, args, from)  → unsigned tx + simulation, ready to hand off
decode_tx(chain, hash)                       → "what did this tx actually do" (heimdall trace decode)
resolve_name(ens/basename) ⇄ address
```

`decode_tx` is a sleeper hit — heimdall already does calldata + trace decoding, so
"explain this transaction" comes almost for free, and agents love it.

## The four faces, ranked by leverage

1. **REST API** — build first; the engine everything wraps. Stateless, cacheable.
2. **MCP server** — thin adapter mapping verbs → MCP tools. Headline agent product.
3. **npm SDK** — typed client over REST; also refactor abi.ninja's frontend onto it
   (kills the client/server resolution split for good).
4. **Skill** — markdown teaching the workflow: resolve → check provenance → read or
   prepare → simulate → hand off. Encodes chain-ID table + "decompiled = be careful."

## Hand-off write flow

```
agent: prepare_tx(...) → { unsignedTx, simulation, humanSummary }
       ↓ presents humanSummary + simulated state diff to the user
user:  approves in their own wallet (WalletConnect / deeplink / abi.ninja UI)
```

- **abi.ninja as the signing surface.** `prepare_tx` returns a shareable abi.ninja
  deeplink (shareable URLs + unfurling already exist) pre-filled with contract/fn/args.
  Agent hands the user a link; user connects wallet and sends. Zero new wallet infra,
  drives traffic back to the app.
- **Always pair unsigned tx with its simulation** — never return blind calldata.

## Differentiators to bake in early

- Proxy resolution (agents get this wrong constantly).
- Human-readable simulation / state diff.
- ENS + basename resolution.
- `decode_tx` for explaining onchain activity.
- Provenance tags so the LLM calibrates its confidence.

## Suggested build order

1. Extract resolver → **REST API** (provenance tags + heimdall fallback wired in).
2. **MCP server** wrapping it + the abi.ninja deeplink hand-off.
3. **Skill** + **SDK** polish layer; refactor frontend onto the SDK.

## Open questions

- Does the heimdall backend (gulltoppr) already expose an HTTP endpoint the API can
  call, or is it CLI-only and needs wrapping?
- Is there an existing public REST surface on abi.ninja today, or is this greenfield?

## Component map

- **abi.ninja** — https://github.com/BuidlGuidl/abi.ninja (frontend, Next.js/SE-2)
- **heimdall-rs** — https://github.com/Jon-Becker/heimdall-rs (Rust decompiler toolkit)
- **gulltoppr** — https://github.com/portdeveloper/gulltoppr (heimdall backend service;
  Gulltoppr = Heimdall's horse in Norse myth)

## Progress tracking

- **gulltoppr** has its own running progress log: `PROGRESS.md` in the gulltoppr repo
  (https://github.com/portdeveloper/gulltoppr/blob/master/PROGRESS.md). That's where
  round-by-round improvements to the heimdall backend are tracked — check it before
  picking up gulltoppr work so we don't repeat or undo something.
