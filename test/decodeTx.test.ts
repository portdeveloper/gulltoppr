import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionData } from "viem";
import type { Abi } from "viem";
import { metricsSnapshot, resetMetricsForTests } from "../src/metrics.js";

const mocks = vi.hoisted(() => ({
  getTransaction: vi.fn(),
  decodeTxViaHeimdall: vi.fn(),
  resolveAbiInternal: vi.fn(),
}));

vi.mock("../src/clients.js", () => ({
  getClient: vi.fn(() => ({ client: { getTransaction: mocks.getTransaction }, resolved: { id: 1, rpcUrl: "http://rpc" } })),
}));

vi.mock("../src/resolve/heimdall.js", () => ({
  decodeTxViaHeimdall: mocks.decodeTxViaHeimdall,
}));

vi.mock("../src/resolve/index.js", () => ({
  resolveAbiInternal: mocks.resolveAbiInternal,
}));

import { decodeTx } from "../src/verbs/decodeTx.js";

const CONTRACT = "0x0000000000000000000000000000000000000002";
const TO = "0x0000000000000000000000000000000000000001";
const HASH = "0x1000000000000000000000000000000000000000000000000000000000000001";
const HASH_NO_ABI = "0x1000000000000000000000000000000000000000000000000000000000000002";
const HASH_RPC = "0x1000000000000000000000000000000000000000000000000000000000000003";

const ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

beforeEach(() => {
  resetMetricsForTests();
  vi.clearAllMocks();
  mocks.decodeTxViaHeimdall.mockResolvedValue({
    source: "heimdall-decoded",
    cached: false,
    decoded: { delegated: true },
  });
  mocks.getTransaction.mockResolvedValue({
    to: CONTRACT,
    input: encodeFunctionData({ abi: ABI, functionName: "transfer", args: [TO, 123n] }),
  });
  mocks.resolveAbiInternal.mockResolvedValue({
    abi: ABI,
    functions: ABI,
    provenance: {
      source: "etherscan",
      confidence: "verified",
      verified: true,
      names_synthetic: false,
      natspec: true,
    },
    abiFor: CONTRACT,
    cached: false,
    chainId: 1,
    client: {},
    rpcUrl: "http://rpc",
  });
});

describe("decodeTx", () => {
  it("adds ABI-decoded calldata when the target ABI resolves", async () => {
    const result = await decodeTx("ethereum", HASH);

    expect(result.decoded).toEqual({ delegated: true });
    expect(result.decoded_call).toMatchObject({
      to: CONTRACT,
      function: "transfer",
      signature: "transfer(address,uint256)",
      abi_for: CONTRACT,
      provenance: { source: "etherscan", confidence: "verified" },
    });
    expect(result.decoded_call?.args).toEqual([
      { name: "to", type: "address", value: TO },
      { name: "amount", type: "uint256", value: "123" },
    ]);
    expect(metricsSnapshot().metrics["rpc.getTransaction.decode_tx"]).toMatchObject({
      attempts: 1,
      successes: 1,
    });
    expect(metricsSnapshot().metrics["rung.heimdall.decode_tx"]).toMatchObject({
      attempts: 1,
      successes: 1,
    });
  });

  it("keeps the delegated decode when ABI enrichment misses", async () => {
    mocks.resolveAbiInternal.mockRejectedValue(new Error("no abi"));

    const result = await decodeTx("ethereum", HASH_NO_ABI);

    expect(result.decoded).toEqual({ delegated: true });
    expect(result.decoded_call).toBeUndefined();
  });

  it("scopes immutable decode cache by rpc_url override", async () => {
    const first = await decodeTx(1, HASH_RPC, "http://rpc-one");
    const second = await decodeTx(1, HASH_RPC, "http://rpc-two");
    const third = await decodeTx(1, HASH_RPC, "http://rpc-one");

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(false);
    expect(third.cached).toBe(true);
    expect(mocks.decodeTxViaHeimdall).toHaveBeenCalledTimes(2);
    expect(mocks.decodeTxViaHeimdall.mock.calls.map((call) => call[1])).toEqual([
      "http://rpc-one",
      "http://rpc-two",
    ]);
  });
});
