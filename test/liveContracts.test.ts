import { describe, it, expect, afterAll, type TestContext } from "vitest";
import { app } from "../src/server.js";

const RUN_LIVE = process.env.RUN_LIVE_CONTRACT_TESTS === "1";
const describeLive = RUN_LIVE ? describe : describe.skip;

// CI passes RPC endpoints via GitHub secrets. An *unset* secret expands to an
// empty string, not undefined, so `?? fallback` would keep the blank value: the
// request then sends `rpc_url=` (empty), the server drops it (`"" || undefined`),
// and the chain falls back to viem's default public RPC (e.g.
// https://56.rpc.thirdweb.com) — which strictly rate-limits and flakes the suite.
// Treat blank/whitespace env values as absent so the reliable fallback is used.
function envOr(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

const ENGINE_BASE_URL = envOr("LIVE_ENGINE_BASE_URL", "").replace(/\/$/, "") || undefined;
const SEPOLIA_RPC_URL = envOr("SEPOLIA_RPC_URL", "https://ethereum-sepolia-rpc.publicnode.com");
const BNB_RPC_URL = envOr("BNB_RPC_URL", "https://bsc-rpc.publicnode.com");
const VICTION_RPC_URL = envOr("VICTION_RPC_URL", "https://rpc.viction.xyz");

const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const DAI_TRANSFER_TX_HASH = "0x8650ad046ce0329a778bf8844cd4b1822a7743fc69a2777520f96599cea7c571";
const BASE_PROXY = "0xca808b3eada02d53073e129b25f74b31d8647ae0";
const SEPOLIA_UNVERIFIED = "0x759c0e9d7858566df8ab751026bedce462ff42df";
const BNB_ETH = "0x2170ed0880ac9a755fd29b2688956bd959f933f8";
const VICTION_TOKEN = "0x381B31409e4D220919B2cFF012ED94d70135A59e";
const MONAD_AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
const MONAD_TESTNET_WETH = "0x45477f4709771331db81944A5E20eF95Bc7BA2D7";
const HOLDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const GREG_BASE = "0x179a862703a4adfb29896552df9e307980d19285";

async function request(path: string, init?: RequestInit): Promise<Response> {
  if (ENGINE_BASE_URL) {
    return fetch(`${ENGINE_BASE_URL}${path}`, init);
  }
  return app.request(path, init);
}

// Upstream/transient failure codes (SPEC §7). The public RPCs these live tests
// hit will intermittently rate-limit (429 → RPC_ERROR), time out, or be briefly
// unavailable — infrastructure flakes, not regressions in this service — so we
// skip on them rather than fail. DECOMPILE_FAILED / ABI_NOT_FOUND are NOT in this
// set: those carry 5xx/4xx too but signal a real regression we want to catch.
const TRANSIENT_UPSTREAM_CODES = new Set(["RPC_ERROR", "UPSTREAM_TIMEOUT", "RATE_LIMITED"]);

class TransientUpstreamError extends Error {}

function transientUpstreamReason(status: number, body: any): string | null {
  if (status === 200) return null;
  const code = body?.error?.code;
  if (typeof code === "string" && TRANSIENT_UPSTREAM_CODES.has(code)) {
    return `${status} ${code}: ${body?.error?.message ?? ""}`.trim();
  }
  return null;
}

// heimdall-api went private (Flycast-only) on 2026-07-27, so it is unreachable
// from outside the Fly org — including from CI, which runs the engine from this
// checkout. That makes rung 4 genuinely unavailable here rather than broken, so
// tests that require a real decompile skip instead of failing. When the suite is
// pointed at a deployed engine (LIVE_ENGINE_BASE_URL) the engine reaches heimdall
// over Flycast itself, so this gate does not apply and rung 4 is covered for real.
let decompileRungReachable: boolean | undefined;
async function heimdallReachable(): Promise<boolean> {
  if (decompileRungReachable === undefined) {
    const base = process.env.HEIMDALL_API_URL ?? "http://heimdall-api.flycast";
    try {
      const res = await fetch(`${base.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(5_000) });
      decompileRungReachable = res.ok;
    } catch {
      decompileRungReachable = false;
    }
  }
  return decompileRungReachable;
}

async function requireDecompileRung(): Promise<void> {
  if (ENGINE_BASE_URL) return; // the deployed engine reaches heimdall privately
  if (!(await heimdallReachable())) {
    throw new TransientUpstreamError(
      "heimdall-api is not reachable from this environment (private Flycast address) — " +
        "rung 4 unavailable; set HEIMDALL_API_URL to your own instance to cover it",
    );
  }
}

const LIVE_MAX_ATTEMPTS = 3;
const LIVE_RETRY_BASE_MS = 1000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// All live endpoints here are read-only (resolve/read/simulate/prepare/decode),
// so retrying is safe. A momentary public-RPC 429/timeout usually clears within a
// second or two, so we retry with linear backoff before giving up; only after
// LIVE_MAX_ATTEMPTS do we throw TransientUpstreamError, which liveTest() turns
// into a skip. This converts most blips into real passes rather than skips.
async function fetchOk(path: string, init?: RequestInit): Promise<{ res: Response; body: any }> {
  let lastTransient: TransientUpstreamError | undefined;
  for (let attempt = 1; attempt <= LIVE_MAX_ATTEMPTS; attempt++) {
    const res = await request(path, init);
    const body = await res.json();
    const transient = transientUpstreamReason(res.status, body);
    if (!transient) {
      expect(res.status, JSON.stringify(body)).toBe(200);
      return { res, body };
    }
    lastTransient = new TransientUpstreamError(transient);
    if (attempt < LIVE_MAX_ATTEMPTS) {
      console.warn(`[live] transient upstream on ${path} (attempt ${attempt}/${LIVE_MAX_ATTEMPTS}): ${transient} — retrying`);
      await sleep(LIVE_RETRY_BASE_MS * attempt);
    }
  }
  throw lastTransient!;
}

async function json(path: string, init?: RequestInit): Promise<any> {
  return (await fetchOk(path, init)).body;
}

async function responseJson(path: string, init?: RequestInit): Promise<{ res: Response; body: any }> {
  return fetchOk(path, init);
}

// Wraps `it` so a transient upstream failure raised by any helper marks the test
// skipped (and visible in the report) instead of failing the run. ctx.skip()
// throws, so the sentinel is captured first and skip() is called outside the
// try/catch — otherwise the catch would swallow the skip signal.
function liveTest(
  name: string,
  fn: (ctx: TestContext) => Promise<void>,
  timeout?: number,
): void {
  it(
    name,
    async (ctx) => {
      let transient: TransientUpstreamError | undefined;
      try {
        await fn(ctx);
      } catch (err) {
        if (err instanceof TransientUpstreamError) {
          transient = err;
        } else {
          throw err;
        }
      }
      if (transient) {
        console.warn(`[live] skipping "${name}": ${transient.message}`);
        ctx.skip(`transient upstream failure: ${transient.message}`);
      }
    },
    timeout,
  );
}

function rpcParam(url: string): string {
  return `rpc_url=${encodeURIComponent(url)}`;
}

function postRead(functionName: string, args: unknown[]): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ function: functionName, args }),
  };
}

function expectReadNamed(result: any, functionName: string): void {
  expect(result.interface.reads.map((fn: any) => fn.function)).toContain(functionName);
}

function expectWriteNamed(result: any, functionName: string): void {
  expect(result.interface.writes.map((fn: any) => fn.function)).toContain(functionName);
}

// --- Upstream-resilient name assertions (SPEC §7 reliability) ----------------
// gulltoppr learns function names from upstream verified sources (Etherscan,
// Sourcify) or, failing those, from heimdall decompilation. When the verified
// rungs are momentarily unavailable, resolution falls through to decompilation
// and names come back synthetic ("Unresolved_<selector>") — an upstream
// availability blip, NOT a regression in this service. These helpers tell the
// two apart so a third-party outage becomes a visible *skip*, not a red run:
//   • name present            → pass (whatever the source)
//   • name absent + synthetic → upstream sources were down → skip (transient)
//   • name absent + verified  → a real regression in our parsing → FAIL
// The mainnet-DAI test stays a strict, never-skipped canary: if even DAI can't
// resolve to real names, the breakage is systemic and we want it loud and red.
function isSyntheticResolution(result: any): boolean {
  const c = result?.provenance?.confidence;
  return result?.provenance?.names_synthetic === true || c === "decompiled" || c === "selector-only";
}

function expectReadNamedOrTransient(result: any, functionName: string): void {
  const names = result.interface.reads.map((fn: any) => fn.function);
  if (names.includes(functionName)) return;
  if (isSyntheticResolution(result)) {
    throw new TransientUpstreamError(
      `verified sources unavailable for chain ${result.chain} ${result.address}: resolved as ` +
        `${result.provenance?.confidence}; "${functionName}" not named`,
    );
  }
  expect(names).toContain(functionName); // verified/partial but missing → real regression
}

function expectWriteNamedOrTransient(result: any, functionName: string, selector: string): void {
  const names = result.interface.writes.map((fn: any) => fn.function);
  if (names.includes(functionName)) return;
  const sel = selector.replace(/^0x/, "");
  if (names.includes(`Unresolved_${sel}`)) {
    throw new TransientUpstreamError(
      `heimdall left selector 0x${sel} unnamed (Unresolved_${sel}) for chain ${result.chain} ` +
        `${result.address} — signature resolution unavailable`,
    );
  }
  expect(names).toContain(functionName); // selector absent entirely → real regression
}

// For verbs that only expose the function name via human-readable text (e.g.
// prepare_tx's human_summary): skip when heimdall left the selector unnamed
// instead of failing on the synthetic "Unresolved_<selector>" string.
function throwIfSelectorUnresolved(text: string, selector: string): void {
  const sel = selector.replace(/^0x/, "");
  if (text.includes(`Unresolved_${sel}`)) {
    throw new TransientUpstreamError(
      `heimdall left selector 0x${sel} unnamed (Unresolved_${sel}) — signature resolution unavailable`,
    );
  }
}

function expectUintRead(result: any, functionSignature: string): void {
  expect(result.function_signature).toBe(functionSignature);
  expect(result.decoded).toHaveLength(1);
  expect(result.decoded[0]).toMatch(/^\d+$/);
}

function expectMetricBucket(metrics: any, name: string): void {
  expect(metrics.metrics[name]).toMatchObject({
    attempts: expect.any(Number),
    successes: expect.any(Number),
    misses: expect.any(Number),
    failures: expect.any(Number),
    total_latency_ms: expect.any(Number),
    avg_latency_ms: expect.any(Number),
    max_latency_ms: expect.any(Number),
    failure_rate: expect.any(Number),
  });
  expect(metrics.metrics[name].attempts).toBeGreaterThan(0);
}

describeLive("live contract interactions", () => {
  liveTest(
    "lists chain aliases with testnet/default-RPC metadata",
    async () => {
      const catalog = await json("/v1/chains?q=monad");
      expect(catalog.chains).toContainEqual(expect.objectContaining({
        id: 143,
        aliases: expect.arrayContaining(["monad", "monad-mainnet"]),
        testnet: false,
        has_default_rpc: true,
        default_rpc_url: expect.stringMatching(/^https?:\/\//),
      }));
      expect(catalog.chains).toContainEqual(expect.objectContaining({
        id: 10143,
        aliases: expect.arrayContaining(["monad-testnet"]),
        testnet: true,
        has_default_rpc: true,
      }));

      const mainnets = await json("/v1/chains?q=monad&testnets=false&has_default_rpc=true");
      expect(mainnets.chains).toContainEqual(expect.objectContaining({ id: 143 }));
      expect(mainnets.chains).not.toContainEqual(expect.objectContaining({ id: 10143 }));
    },
    60_000,
  );

  // CANARY — strict, never skipped. DAI is the most-verified contract on
  // mainnet and the one chain with a guaranteed Etherscan key. If even this
  // resolves to synthetic names, the failure is systemic (key revoked, parser
  // broken, both verified-source providers down) and the other tests' transient
  // skips would be hiding a real outage — so this one stays loud and red.
  liveTest(
    "loads DAI on mainnet and reads balanceOf",
    async () => {
      const { res, body: resolved } = await responseJson(`/v1/ethereum/${DAI}/abi`);
      expect(Number(res.headers.get("x-elapsed-ms"))).toBeGreaterThanOrEqual(0);
      expect(resolved.address).toBe(DAI);
      expect(resolved.chain).toBe(1);
      expectReadNamed(resolved, "balanceOf");
      expect(resolved.provenance.confidence).toMatch(/^(verified|partial)$/);

      const read = await json(`/v1/ethereum/${DAI}/read`, postRead("balanceOf", [DAI]));
      expectUintRead(read, "balanceOf(address)");
    },
    60_000,
  );

  liveTest(
    "loads a compact DAI manifest without raw ABI for token-efficient agent context",
    async () => {
      const resolved = await json(`/v1/ethereum/${DAI}/abi?include_abi=false`);
      expect(resolved.address).toBe(DAI);
      expect(resolved.chain).toBe(1);
      expect(resolved.abi).toBeUndefined();
      expect(resolved.abi_omitted).toBe(true);
      expectReadNamed(resolved, "balanceOf");
      expect(resolved.provenance.confidence).toMatch(/^(verified|partial|decompiled)$/);
    },
    60_000,
  );

  liveTest(
    "filters a live compact DAI manifest by write method intent",
    async () => {
      const resolved = await json(`/v1/ethereum/${DAI}/abi?include_abi=false&method_q=approve&method_kind=write&method_limit=1`);
      expect(resolved.abi).toBeUndefined();
      expect(resolved.abi_omitted).toBe(true);
      expect(resolved.interface.reads).toEqual([]);
      expect(resolved.interface.writes).toEqual([
        expect.objectContaining({
          function: "approve",
          signature: "approve(address,uint256)",
          inputs: expect.arrayContaining([
            expect.objectContaining({ type: "address" }),
            expect.objectContaining({ type: "uint256" }),
          ]),
        }),
      ]);
    },
    60_000,
  );

  liveTest(
    "prepares a DAI write with simulation, unsigned tx, wallet hand-off, summary, and warnings",
    async () => {
      const spender = "0x0000000000000000000000000000000000000001";
      const prepared = await json(
        `/v1/ethereum/${DAI}/prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: HOLDER, function: "approve", args: [spender, "0"] }),
        },
      );

      expect(prepared.unsigned_tx).toMatchObject({
        chainId: 1,
        to: DAI,
        from: HOLDER,
        value: "0",
      });
      expect(prepared.unsigned_tx.data).toMatch(/^0x[0-9a-f]+$/);
      expect(prepared.simulation.success).toBe(true);
      expect(prepared.human_summary).toContain("approve(address,uint256)");
      expect(prepared.deeplink).toContain("/1/");
      expect(prepared.wallet_request).toMatchObject({
        chainId: 1,
        method: "eth_sendTransaction",
        params: [{ from: HOLDER, to: DAI, data: prepared.unsigned_tx.data, value: "0x0" }],
      });
      expect(prepared.warnings).not.toContainEqual(expect.stringMatching(/Simulation REVERTS/));
      expect(prepared.safety).toMatchObject({
        signing_recommended: true,
        risk_level: "low",
        requires_human_confirmation: false,
        reasons: [],
      });
    },
    60_000,
  );

  liveTest(
    "prepares a DAI transfer with asset-outflow safety even when traces are thin",
    async () => {
      const recipient = "0x0000000000000000000000000000000000000001";
      const prepared = await json(
        `/v1/ethereum/${DAI}/prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: HOLDER, function: "transfer", args: [recipient, "1"] }),
        },
      );

      expect(prepared.simulation.success).toBe(true);
      expect(prepared.human_summary).toContain("transfer(address,uint256)");
      expect(prepared.safety).toMatchObject({
        signing_recommended: true,
        risk_level: "medium",
        requires_human_confirmation: true,
        reasons: expect.arrayContaining(["asset_outflow"]),
      });
      expect(prepared.warnings.join(" ")).toContain("erc20 units");
      expect(prepared.wallet_request).toMatchObject({
        chainId: 1,
        method: "eth_sendTransaction",
      });
    },
    60_000,
  );

  liveTest(
    "prepares a DAI approval with spender-approval safety",
    async () => {
      const spender = "0x0000000000000000000000000000000000000001";
      const prepared = await json(
        `/v1/ethereum/${DAI}/prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: HOLDER, function: "approve", args: [spender, "1"] }),
        },
      );

      expect(prepared.simulation.success).toBe(true);
      expect(prepared.human_summary).toContain("approve(address,uint256)");
      expect(prepared.safety).toMatchObject({
        signing_recommended: true,
        risk_level: "medium",
        requires_human_confirmation: true,
        reasons: expect.arrayContaining(["spending_approval"]),
      });
      expect(prepared.warnings.join(" ")).toContain("approves");
      expect(prepared.warnings.join(" ")).toContain(spender);
      expect(prepared.wallet_request).toMatchObject({
        chainId: 1,
        method: "eth_sendTransaction",
      });
    },
    60_000,
  );

  liveTest(
    "blocks DAI signing hand-off when live simulation reverts",
    async () => {
      const recipient = "0x0000000000000000000000000000000000000001";
      const prepared = await json(
        `/v1/ethereum/${DAI}/prepare`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            from: HOLDER,
            function: "transfer",
            args: [recipient, "1000000000000000000000000000000000000"],
          }),
        },
      );

      expect(prepared.simulation.success).toBe(false);
      expect(prepared.simulation.revert.reason).toMatch(/insufficient|revert/i);
      expect(prepared.deeplink).toBe("");
      expect(prepared.wallet_request).toBeUndefined();
      expect(prepared.safety).toMatchObject({
        signing_recommended: false,
        risk_level: "blocked",
        requires_human_confirmation: true,
        reasons: expect.arrayContaining(["simulation_failed"]),
      });
      expect(prepared.warnings.join(" ")).toContain("do not send this transaction");
    },
    60_000,
  );

  liveTest(
    "decodes a DAI transfer transaction with resolved calldata names",
    async () => {
      await requireDecompileRung(); // this path is heimdall-decoded by definition
      const decoded = await json(`/v1/ethereum/tx/${DAI_TRANSFER_TX_HASH}`);

      expect(decoded).toMatchObject({
        chain: 1,
        tx_hash: DAI_TRANSFER_TX_HASH,
        source: "heimdall-decoded",
        provenance: {
          confidence: "decompiled",
          names_synthetic: true,
        },
        decoded_call: {
          to: DAI.toLowerCase(),
          function: "transfer",
          signature: "transfer(address,uint256)",
          abi_for: DAI,
        },
      });
      expect(decoded.decoded_call.provenance.confidence).toMatch(/^(verified|partial)$/);
      expect(decoded.decoded_call.args).toEqual([
        expect.objectContaining({ type: "address", value: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/) }),
        expect.objectContaining({ type: "uint256", value: expect.stringMatching(/^\d+$/) }),
      ]);

      if (!ENGINE_BASE_URL) {
        const metrics = await json("/v1/metrics");
        expectMetricBucket(metrics, "rung.heimdall.decode_tx");
        expectMetricBucket(metrics, "rpc.getTransaction.decode_tx");
      }
    },
    60_000,
  );

  liveTest(
    "loads a Base proxy and reads balanceOf through the resolved implementation ABI",
    async () => {
      const resolved = await json(`/v1/base/${BASE_PROXY}/abi`);
      expect(resolved.address.toLowerCase()).toBe(BASE_PROXY);
      expect(resolved.chain).toBe(8453);
      expect(resolved.proxy?.resolved_implementation).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expectReadNamedOrTransient(resolved, "balanceOf");

      const read = await json(`/v1/base/${BASE_PROXY}/read`, postRead("balanceOf", [HOLDER]));
      expectUintRead(read, "balanceOf(address)");
    },
    60_000,
  );

  liveTest(
    "resolves a Basename through the Base chain path",
    async () => {
      const resolved = await json("/v1/base/name/greg.base.eth");
      expect(resolved).toEqual({ name: "greg.base.eth", address: GREG_BASE });
      if (!ENGINE_BASE_URL) {
        const metrics = await json("/v1/metrics");
        expectMetricBucket(metrics, "rpc.getEnsAddress.resolve_name");
      }
    },
    60_000,
  );

  liveTest(
    "loads an unverified Sepolia contract and exposes the decompiled changeOwner write",
    async () => {
      const resolved = await json(`/v1/11155111/${SEPOLIA_UNVERIFIED}/abi?${rpcParam(SEPOLIA_RPC_URL)}`);
      expect(resolved.chain).toBe(11155111);
      // Unverified contract: we expect a heimdall decompilation. If heimdall-api
      // is down, resolution falls through to selector-only (4byte) — an upstream
      // outage, not a regression — so skip rather than fail on the wrong source.
      if (resolved.provenance.source !== "heimdall-decompiled") {
        throw new TransientUpstreamError(
          `expected heimdall decompilation; got ${resolved.provenance.source}/` +
            `${resolved.provenance.confidence} — heimdall-api unavailable`,
        );
      }
      expect(resolved.provenance.confidence).toBe("decompiled");
      expect(resolved.provenance.names_synthetic).toBe(true);
      expectWriteNamedOrTransient(resolved, "changeOwner", "0xa6f9dae1");
    },
    90_000,
  );

  liveTest(
    "marks a live decompiled write as high-friction even when simulation succeeds",
    async () => {
      const prepared = await json(
        `/v1/11155111/${SEPOLIA_UNVERIFIED}/prepare?${rpcParam(SEPOLIA_RPC_URL)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ from: HOLDER, function: "changeOwner", args: [HOLDER] }),
        },
      );

      // If heimdall left the selector unnamed (signature DB blip), the summary
      // reads "Unresolved_a6f9dae1(...)" instead of "changeOwner(...)" — that's
      // an upstream outage, so skip rather than fail.
      throwIfSelectorUnresolved(prepared.human_summary, "0xa6f9dae1");
      expect(prepared.human_summary).toContain("changeOwner(address)");
      expect(prepared.simulation.success).toBe(true);
      expect(prepared.deeplink).toContain("/11155111/");
      expect(prepared.wallet_request).toMatchObject({
        chainId: 11155111,
        method: "eth_sendTransaction",
        params: [{ from: HOLDER, to: SEPOLIA_UNVERIFIED, data: prepared.unsigned_tx.data, value: "0x0" }],
      });
      expect(prepared.safety).toMatchObject({
        signing_recommended: true,
        risk_level: "high",
        requires_human_confirmation: true,
        reasons: ["abi_names_inferred"],
      });
      expect(prepared.warnings.join(" ")).toContain("High-friction write");
      expect(prepared.warnings.join(" ")).toContain("confirm the selector and intent");
    },
    90_000,
  );

  liveTest(
    "loads a BNB Smart Chain contract via rpc_url and reads balanceOf",
    async () => {
      const path = `/v1/56/${BNB_ETH}`;
      const resolved = await json(`${path}/abi?${rpcParam(BNB_RPC_URL)}`);
      expect(resolved.address.toLowerCase()).toBe(BNB_ETH);
      expect(resolved.chain).toBe(56);
      expectReadNamedOrTransient(resolved, "balanceOf");

      const read = await json(`${path}/read?${rpcParam(BNB_RPC_URL)}`, postRead("balanceOf", [HOLDER]));
      expectUintRead(read, "balanceOf(address)");
    },
    60_000,
  );

  liveTest(
    "loads a Monad mainnet token via default RPC and reads balanceOf",
    async () => {
      const resolved = await json(`/v1/monad/${MONAD_AUSD}/abi`);
      expect(resolved.address).toBe(MONAD_AUSD);
      expect(resolved.chain).toBe(143);
      expectReadNamedOrTransient(resolved, "balanceOf");

      const read = await json(`/v1/monad/${MONAD_AUSD}/read`, postRead("balanceOf", [HOLDER]));
      expectUintRead(read, "balanceOf(address)");
    },
    90_000,
  );

  liveTest(
    "loads a Monad testnet token via default RPC and reads balanceOf",
    async () => {
      const resolved = await json(`/v1/monad-testnet/${MONAD_TESTNET_WETH}/abi`);
      expect(resolved.address).toBe(MONAD_TESTNET_WETH);
      expect(resolved.chain).toBe(10143);
      expectReadNamedOrTransient(resolved, "balanceOf");

      const read = await json(`/v1/monad-testnet/${MONAD_TESTNET_WETH}/read`, postRead("balanceOf", [HOLDER]));
      expectUintRead(read, "balanceOf(address)");
    },
    90_000,
  );

  liveTest(
    "loads a Viction contract via custom chain id and rpc_url, then reads balanceOf",
    async () => {
      const path = `/v1/88/${VICTION_TOKEN}`;
      const resolved = await json(`${path}/abi?${rpcParam(VICTION_RPC_URL)}`);
      expect(resolved.address).toBe(VICTION_TOKEN);
      expect(resolved.chain).toBe(88);
      expect(resolved.provenance.confidence).toMatch(/^(verified|partial|decompiled|selector-only)$/);
      expectReadNamedOrTransient(resolved, "balanceOf");

      const read = await json(`${path}/read?${rpcParam(VICTION_RPC_URL)}`, postRead("balanceOf", [HOLDER]));
      expectUintRead(read, "balanceOf(address)");
    },
    90_000,
  );

  liveTest(
    "exposes runtime metrics after live agent-style calls",
    async () => {
      const read = await json(`/v1/ethereum/${DAI}/read`, postRead("balanceOf", [DAI]));
      expectUintRead(read, "balanceOf(address)");

      const metrics = await json("/v1/metrics");
      expect(metrics).toMatchObject({
        uptime_seconds: expect.any(Number),
        metrics: expect.any(Object),
      });

      if (!ENGINE_BASE_URL) {
        expectMetricBucket(metrics, "rpc.eth_call.read_contract");
      }
    },
    60_000,
  );

  // Per-rung health snapshot → CI job summary (and stdout). Surfaces a degrading
  // dependency (rising failure_rate / latency on Etherscan, Sourcify, heimdall,
  // 4byte, proxy detection) every run — green, skipped, or red — so you can see
  // a provider going bad *before* it actually flakes the suite. In-process only.
  afterAll(async () => {
    if (ENGINE_BASE_URL) return; // these metrics belong to the in-process engine
    let metrics: any;
    try {
      const res = await request("/v1/metrics");
      if (!res.ok) return;
      metrics = await res.json();
    } catch {
      return;
    }
    const rungs = Object.entries(metrics.metrics ?? {})
      .filter(([name]) => name.startsWith("rung."))
      .sort(([a], [b]) => a.localeCompare(b));
    if (!rungs.length) return;
    const table = [
      "### Live suite — resolution rung health",
      "",
      "| rung | attempts | failures | failure_rate | avg_ms |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...rungs.map(
        ([name, b]: [string, any]) =>
          `| ${name} | ${b.attempts} | ${b.failures} | ${b.failure_rate} | ${b.avg_latency_ms} |`,
      ),
      "",
    ].join("\n");
    console.log("\n" + table);
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(summaryPath, table + "\n");
    }
  });
});
