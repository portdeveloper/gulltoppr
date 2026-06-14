import { describe, it, expect } from "vitest";
import { app } from "../src/server.js";

const RUN_LIVE = process.env.RUN_LIVE_CONTRACT_TESTS === "1";
const describeLive = RUN_LIVE ? describe : describe.skip;

const ENGINE_BASE_URL = process.env.LIVE_ENGINE_BASE_URL?.replace(/\/$/, "");
const SEPOLIA_RPC_URL = process.env.SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com";
const BNB_RPC_URL = process.env.BNB_RPC_URL ?? "https://bsc-rpc.publicnode.com";
const VICTION_RPC_URL = process.env.VICTION_RPC_URL ?? "https://rpc.viction.xyz";

const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const BASE_PROXY = "0xca808b3eada02d53073e129b25f74b31d8647ae0";
const SEPOLIA_UNVERIFIED = "0x759c0e9d7858566df8ab751026bedce462ff42df";
const BNB_ETH = "0x2170ed0880ac9a755fd29b2688956bd959f933f8";
const VICTION_TOKEN = "0x381B31409e4D220919B2cFF012ED94d70135A59e";
const HOLDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

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

function expectUintRead(result: any, functionName: string): void {
  expect(result.function_signature).toBe(functionName);
  expect(result.decoded).toHaveLength(1);
  expect(result.decoded[0]).toMatch(/^\d+$/);
}

describeLive("live contract interactions", () => {
  it(
    "loads DAI on mainnet and reads balanceOf",
    async () => {
      const resolved = await json(`/v1/ethereum/${DAI}/abi`);
      expect(resolved.address).toBe(DAI);
      expect(resolved.chain).toBe(1);
      expectReadNamed(resolved, "balanceOf");
      expect(resolved.provenance.confidence).toMatch(/^(verified|partial|decompiled)$/);

      const read = await json(`/v1/ethereum/${DAI}/read`, postRead("balanceOf", [DAI]));
      expectUintRead(read, "balanceOf");
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
      expectUintRead(read, "balanceOf");
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
    "loads a BNB Smart Chain contract via rpc_url and reads balanceOf",
    async () => {
      const path = `/v1/56/${BNB_ETH}`;
      const resolved = await json(`${path}/abi?${rpcParam(BNB_RPC_URL)}`);
      expect(resolved.address.toLowerCase()).toBe(BNB_ETH);
      expect(resolved.chain).toBe(56);
      expectReadNamed(resolved, "balanceOf");

      const read = await json(`${path}/read?${rpcParam(BNB_RPC_URL)}`, postRead("balanceOf", [HOLDER]));
      expectUintRead(read, "balanceOf");
    },
    60_000,
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
      expectUintRead(read, "balanceOf");
    },
    90_000,
  );
});
