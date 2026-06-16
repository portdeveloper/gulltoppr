# gulltoppr integration recipes

Use these recipes when wiring gulltoppr into places where agents already work:
wallets, block explorers, coding agents, and MCP clients.

## Shared rule

`prepare_tx` is non-custodial. It returns an unsigned transaction, simulation,
human summary, warnings, safety metadata, a deeplink, and optionally
`wallet_request`. It never signs, asks for keys, or broadcasts.

Only hand off `deeplink` or `wallet_request` when:

```ts
prep.safety.signing_recommended === true
```

If `prep.safety.risk_level` is `"blocked"`, the simulation failed and the
transaction should not be sent.

## Wallets and apps

Use `wallet_request` when your app already owns wallet connection. It is shaped for
EIP-1193 `provider.request`, with `method: "eth_sendTransaction"` and hex JSON-RPC
quantities already formatted.

```ts
import { Gulltoppr, requireLowRiskWalletRequest, requireWalletRequest } from "gulltoppr";

const gulltoppr = new Gulltoppr();

const prep = await gulltoppr.prepareTx("base", tokenAddress, "approve", [spender, amount], {
  from: userAddress,
});

showSummary(prep.human_summary);
showSimulation(prep.simulation);
showWarnings(prep.warnings);

const walletRequest = requireWalletRequest(prep);

await provider.request({
  method: "wallet_switchEthereumChain",
  params: [{ chainId: `0x${walletRequest.chainId.toString(16)}` }],
});

const { chainId: _chainId, ...providerRequest } = walletRequest;
const txHash = await provider.request(providerRequest);
```

Use `requireLowRiskWalletRequest(prep)` instead when your app should stop before
any confirmation-required write, including spender approvals, asset outflows,
proxies, native value, or inferred ABI names.

For deeplink-only clients, show `prep.deeplink` under the same safety gate.

## Block explorers

Explorers can use gulltoppr as a fallback when source verification is missing or
when a proxy makes the displayed ABI ambiguous.

```ts
import { searchContractMethods } from "gulltoppr";

const resolved = await gulltoppr.resolveManifest(chain, address, { rpcUrl });

renderMethods(resolved.interface.reads, resolved.interface.writes);
renderProvenance(resolved.provenance, resolved.proxy, resolved.abi_for);

const transferLike = searchContractMethods(resolved.interface, {
  q: "transfer address",
  kind: "all",
  limit: 25,
});

const decoded = await gulltoppr.decodeTx(chain, txHash, { rpcUrl });
renderDecodedCall(decoded.decoded_call ?? decoded.decoded);
```

When `resolved.provenance.confidence` is `decompiled` or `selector-only`, label
function names as inferred. Do not present synthetic names as verified source.
When `resolved.provenance.bytecode_match` is present, show the matched
chain/address/source/confidence so users can see which prior ABI was reused.

## Coding agents

Point agents at the remote MCP endpoint when supported:

```json
{ "mcpServers": { "gulltoppr": { "url": "https://mcp.gulltoppr.dev/mcp" } } }
```

For agents that inspect docs or OpenAPI, expose these URLs:

- `https://api.gulltoppr.dev/`
- `https://gulltoppr.dev/llms.txt`
- `https://api.gulltoppr.dev/openapi.json`
- `https://api.gulltoppr.dev/v1/chains`
- `https://mcp.gulltoppr.dev/server.json`
- `https://mcp.gulltoppr.dev/.well-known/mcp-server.json`

The OpenAPI `info` object also includes `x-docs`, `x-llms`, `x-sdk`,
`x-mcp-remote`, `x-mcp-metadata`, and `x-repository` links so spec-only clients
can discover the rest of the integration surface.

REST responses expose operational headers useful for integrations:
`Cache-Control`, `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and
`Retry-After` on 429s. ABI resolves also include `X-Source`, `X-Confidence`,
`X-Cache`, `X-Elapsed-Ms`, and `X-ABI-Included`.

Recommended agent workflow:

1. Use `list_chains` when the chain alias or `rpc_url` requirement is unclear
2. `resolve_abi`
3. Inspect `provenance`, `proxy`, and `token`
4. Use `read_contract` for view/pure calls
5. Use `prepare_tx` for writes
6. Show `human_summary`, `simulation`, `warnings`, and `safety.reasons`
7. Hand off `deeplink` or `wallet_request` only when safety recommends signing

Utility MCP tools mirror the REST/SDK support surface: `lookup_selector`,
`registry_stats`, `export_registry`, and `runtime_metrics`.
MCP `resolve_abi` omits the raw ABI and leads with a `WARNING` before the JSON for
partial, proxy, bytecode-match, decompiled, or selector-only provenance. JSON MCP
tools return structured content with output schemas; use structured `provenance`,
`decoded_call`, `simulation`, selector results, metrics, and `safety` objects
instead of parsing warning or JSON text. `export_registry` remains NDJSON text for
bulk CC0 export.

## Long-tail chains

Use `GET /v1/chains` for built-in aliases and pass `rpc_url` for custom, private,
or newly launched EVM chains. Chain entries include `testnet` and
`has_default_rpc`, and the same filters are available through `list_chains`:
`q` searches ids, names, aliases, and native symbols, including multi-word queries
such as `bnb chain`.

```ts
await gulltoppr.resolveAbi(88, "0x381B31409e4D220919B2cFF012ED94d70135A59e", {
  rpcUrl: "https://rpc.viction.xyz",
});
```

Numeric chain id plus `rpc_url` is the escape hatch; do not wait for gulltoppr to
curate every RPC endpoint.
