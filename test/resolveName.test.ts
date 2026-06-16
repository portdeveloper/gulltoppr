import { beforeEach, describe, expect, it, vi } from "vitest";
import { toCoinType } from "viem";

const mocks = vi.hoisted(() => ({
  getEnsAddress: vi.fn(),
  getEnsName: vi.fn(),
}));

vi.mock("../src/clients.js", () => ({
  getEnsClient: () => mocks,
}));

import { resolveName } from "../src/verbs/resolveName.js";
import { metricsSnapshot, resetMetricsForTests } from "../src/metrics.js";

const ADDR = "0x0000000000000000000000000000000000000001";

describe("resolveName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetMetricsForTests();
    mocks.getEnsAddress.mockResolvedValue(null);
    mocks.getEnsName.mockResolvedValue(null);
  });

  it("resolves Ethereum ENS names with the default coin type", async () => {
    mocks.getEnsAddress.mockResolvedValue(ADDR);

    await expect(resolveName("ethereum", "vitalik.eth")).resolves.toEqual({
      name: "vitalik.eth",
      address: ADDR,
    });
    expect(mocks.getEnsAddress).toHaveBeenCalledWith({ name: "vitalik.eth" });
    expect(metricsSnapshot().metrics["rpc.getEnsAddress.resolve_name"]).toMatchObject({
      attempts: 1,
      successes: 1,
    });
  });

  it("resolves Base/Basenames forward records with Base coin type", async () => {
    mocks.getEnsAddress.mockResolvedValue(ADDR);

    await expect(resolveName("base", "example.base.eth")).resolves.toEqual({
      name: "example.base.eth",
      address: ADDR,
    });
    expect(mocks.getEnsAddress).toHaveBeenCalledWith({
      name: "example.base.eth",
      coinType: toCoinType(8453),
    });
  });

  it("resolves numeric long-tail chain records by ENS coin type without a chain RPC", async () => {
    mocks.getEnsAddress.mockResolvedValue(ADDR);

    await expect(resolveName(8217, "example.eth")).resolves.toEqual({
      name: "example.eth",
      address: ADDR,
    });
    expect(mocks.getEnsAddress).toHaveBeenCalledWith({
      name: "example.eth",
      coinType: toCoinType(8217),
    });
  });

  it("resolves Base primary names with Base coin type", async () => {
    mocks.getEnsName.mockResolvedValue("example.base.eth");

    await expect(resolveName("base", ADDR)).resolves.toEqual({
      address: ADDR,
      name: "example.base.eth",
    });
    expect(mocks.getEnsName).toHaveBeenCalledWith({
      address: ADDR,
      coinType: toCoinType(8453),
    });
    expect(metricsSnapshot().metrics["rpc.getEnsName.resolve_name"]).toMatchObject({
      attempts: 1,
      successes: 1,
    });
  });

  it("records misses and failures while preserving empty-result behavior", async () => {
    await expect(resolveName("ethereum", "missing.eth")).resolves.toEqual({ name: "missing.eth" });
    expect(metricsSnapshot().metrics["rpc.getEnsAddress.resolve_name"]).toMatchObject({
      attempts: 1,
      misses: 1,
    });

    mocks.getEnsName.mockRejectedValue(new Error("resolver unavailable"));
    await expect(resolveName("ethereum", ADDR)).resolves.toEqual({ address: ADDR });
    expect(metricsSnapshot().metrics["rpc.getEnsName.resolve_name"]).toMatchObject({
      attempts: 1,
      failures: 1,
      last_error: "resolver unavailable",
    });
  });

  it("rejects unknown chain aliases instead of silently resolving on mainnet", async () => {
    await expect(resolveName("notachain", "vitalik.eth")).rejects.toMatchObject({ code: "UNKNOWN_CHAIN" });
  });

  it("rejects invalid ENS/Basename syntax before resolver calls", async () => {
    await expect(resolveName("ethereum", "bad name.eth")).rejects.toMatchObject({
      code: "INVALID_ARGS",
      message: 'Not a valid ENS/Basename: "bad name.eth"',
    });
    expect(mocks.getEnsAddress).not.toHaveBeenCalled();
  });

  it("rejects invalid numeric chain ids for coin-type resolution", async () => {
    await expect(resolveName(0, "vitalik.eth")).rejects.toMatchObject({ code: "UNKNOWN_CHAIN" });
    await expect(resolveName(Number.NaN, "vitalik.eth")).rejects.toMatchObject({ code: "UNKNOWN_CHAIN" });
    await expect(resolveName("9007199254740992", "vitalik.eth")).rejects.toMatchObject({ code: "UNKNOWN_CHAIN" });
  });
});
