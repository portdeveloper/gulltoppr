import { describe, it, expect } from "vitest";
import { app } from "../src/server.js";

const RUN_LIVE = process.env.RUN_LIVE_CONTRACT_TESTS === "1";
const describeLive = RUN_LIVE ? describe : describe.skip;

const ENGINE_BASE_URL = process.env.LIVE_ENGINE_BASE_URL?.replace(/\/$/, "");
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const BNB_RPC_URL = process.env.BNB_RPC_URL ?? "https://bsc-rpc.publicnode.com";
const VICTION_RPC_URL = process.env.VICTION_RPC_URL ?? "https://rpc.viction.xyz";

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

async function json(path: string, init?: RequestInit): Promise<any> {
  const res = await request(path, init);
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body;
}

async function responseJson(path: string, init?: RequestInit): Promise<{ res: Response; body: any }> {
  const res = await request(path, init);
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  return { res, body };
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
  it(
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

  it(
    "loads DAI on mainnet and reads balanceOf",
    async () => {
      const { res, body: resolved } = await responseJson(`/v1/ethereum/${DAI}/abi`);
      expect(Number(res.headers.get("x-elapsed-ms"))).toBeGreaterThanOrEqual(0);
      expect(resolved.address).toBe(DAI);
      expect(resolved.chain).toBe(1);
      expectReadNamed(resolved, "balanceOf");
      expect(resolved.provenance.confidence).toMatch(/^(verified|partial|decompiled)$/);

      const read = await json(`/v1/ethereum/${DAI}/read`, postRead("balanceOf", [DAI]));
      expectUintRead(read, "balanceOf(address)");
    },
    60_000,
  );

  it(
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

  it(
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

  it(
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

  it(
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

  it(
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

  it(
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

  it(
    "decodes a DAI transfer transaction with resolved calldata names",
    async () => {
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

  it(
    "loads a Base proxy and reads balanceOf through the resolved implementation ABI",
    async () => {
      const resolved = await json(`/v1/base/${BASE_PROXY}/abi`);
      expect(resolved.address.toLowerCase()).toBe(BASE_PROXY);
      expect(resolved.chain).toBe(8453);
      expect(resolved.proxy?.resolved_implementation).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expectReadNamed(resolved, "balanceOf");

      const read = await json(`/v1/base/${BASE_PROXY}/read`, postRead("balanceOf", [HOLDER]));
      expectUintRead(read, "balanceOf(address)");
    },
    60_000,
  );

  it(
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

  it(
    "loads an unverified Sepolia contract and exposes the decompiled changeOwner write",
    async () => {
      const resolved = await json(`/v1/11155111/${SEPOLIA_UNVERIFIED}/abi?${rpcParam(SEPOLIA_RPC_URL)}`);
      expect(resolved.chain).toBe(11155111);
      expect(resolved.provenance).toMatchObject({
        source: "heimdall-decompiled",
        confidence: "decompiled",
        names_synthetic: true,
      });
      expectWriteNamed(resolved, "changeOwner");
    },
    90_000,
  );

  it(
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

  it(
    "loads a BNB Smart Chain contract via rpc_url and reads balanceOf",
    async () => {
      const path = `/v1/56/${BNB_ETH}`;
      const resolved = await json(`${path}/abi?${rpcParam(BNB_RPC_URL)}`);
      expect(resolved.address.toLowerCase()).toBe(BNB_ETH);
      expect(resolved.chain).toBe(56);
      expectReadNamed(resolved, "balanceOf");

      const read = await json(`${path}/read?${rpcParam(BNB_RPC_URL)}`, postRead("balanceOf", [HOLDER]));
      expectUintRead(read, "balanceOf(address)");
    },
    60_000,
  );

  it(
    "loads a Monad mainnet token via default RPC and reads balanceOf",
    async () => {
      const resolved = await json(`/v1/monad/${MONAD_AUSD}/abi`);
      expect(resolved.address).toBe(MONAD_AUSD);
      expect(resolved.chain).toBe(143);
      expectReadNamed(resolved, "balanceOf");

      const read = await json(`/v1/monad/${MONAD_AUSD}/read`, postRead("balanceOf", [HOLDER]));
      expectUintRead(read, "balanceOf(address)");
    },
    90_000,
  );

  it(
    "loads a Monad testnet token via default RPC and reads balanceOf",
    async () => {
      const resolved = await json(`/v1/monad-testnet/${MONAD_TESTNET_WETH}/abi`);
      expect(resolved.address).toBe(MONAD_TESTNET_WETH);
      expect(resolved.chain).toBe(10143);
      expectReadNamed(resolved, "balanceOf");

      const read = await json(`/v1/monad-testnet/${MONAD_TESTNET_WETH}/read`, postRead("balanceOf", [HOLDER]));
      expectUintRead(read, "balanceOf(address)");
    },
    90_000,
  );

  it(
    "loads a Viction contract via custom chain id and rpc_url, then reads balanceOf",
    async () => {
      const path = `/v1/88/${VICTION_TOKEN}`;
      const resolved = await json(`${path}/abi?${rpcParam(VICTION_RPC_URL)}`);
      expect(resolved.address).toBe(VICTION_TOKEN);
      expect(resolved.chain).toBe(88);
      expect(resolved.provenance.confidence).toMatch(/^(verified|partial|decompiled|selector-only)$/);
      expectReadNamed(resolved, "balanceOf");

      const read = await json(`${path}/read?${rpcParam(VICTION_RPC_URL)}`, postRead("balanceOf", [HOLDER]));
      expectUintRead(read, "balanceOf(address)");
    },
    90_000,
  );

  it(
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
});
