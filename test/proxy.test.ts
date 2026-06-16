import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress } from "viem";
import { detectProxy } from "../src/resolve/proxy.js";
import { metricsSnapshot, resetMetricsForTests } from "../src/metrics.js";

const ADDR = "0x0000000000000000000000000000000000000001";
const IMPL = "0x00000000000000000000000000000000000000ff";
const BEACON = getAddress("0x00000000000000000000000000000000000000be");
const ZERO_SLOT = `0x${"0".repeat(64)}` as `0x${string}`;

function slotFor(address: string): `0x${string}` {
  return `0x${"0".repeat(24)}${address.slice(2)}` as `0x${string}`;
}

describe("proxy detection", () => {
  beforeEach(() => resetMetricsForTests());

  it("records EIP-1967 implementation/admin slot RPC metrics", async () => {
    const client = {
      getStorageAt: vi
        .fn()
        .mockResolvedValueOnce(slotFor(IMPL))
        .mockResolvedValueOnce(ZERO_SLOT),
      readContract: vi.fn(),
      getCode: vi.fn(),
    };

    await expect(detectProxy(client as any, ADDR as any)).resolves.toEqual({
      pattern: "eip1967",
      implementation: IMPL,
    });
    expect(client.getStorageAt).toHaveBeenCalledTimes(2);
    expect(client.readContract).not.toHaveBeenCalled();
    expect(client.getCode).not.toHaveBeenCalled();
    expect(metricsSnapshot().metrics).toMatchObject({
      "rpc.getStorageAt.proxy.implementation_slot": { attempts: 1, successes: 1 },
      "rpc.getStorageAt.proxy.admin_slot": { attempts: 1, successes: 1 },
    });
  });

  it("records beacon slot and implementation RPC metrics", async () => {
    const client = {
      getStorageAt: vi
        .fn()
        .mockResolvedValueOnce(ZERO_SLOT)
        .mockResolvedValueOnce(slotFor(BEACON)),
      readContract: vi.fn(async () => IMPL),
      getCode: vi.fn(),
    };

    await expect(detectProxy(client as any, ADDR as any)).resolves.toEqual({
      pattern: "beacon",
      implementation: IMPL,
      beacon: BEACON,
    });
    expect(metricsSnapshot().metrics).toMatchObject({
      "rpc.getStorageAt.proxy.implementation_slot": { attempts: 1, successes: 1 },
      "rpc.getStorageAt.proxy.beacon_slot": { attempts: 1, successes: 1 },
      "rpc.readContract.proxy.beacon_implementation": { attempts: 1, successes: 1 },
    });
  });

  it("records minimal proxy bytecode RPC metrics", async () => {
    const client = {
      getStorageAt: vi.fn(async () => ZERO_SLOT),
      readContract: vi.fn(),
      getCode: vi.fn(async () => `0x363d3d373d3d3d363d73${IMPL.slice(2)}5af43d82803e903d91602b57fd5bf3`),
    };

    await expect(detectProxy(client as any, ADDR as any)).resolves.toEqual({
      pattern: "minimal-1167",
      implementation: IMPL,
    });
    expect(client.readContract).not.toHaveBeenCalled();
    expect(metricsSnapshot().metrics).toMatchObject({
      "rpc.getStorageAt.proxy.implementation_slot": { attempts: 1, successes: 1 },
      "rpc.getStorageAt.proxy.beacon_slot": { attempts: 1, successes: 1 },
      "rpc.getCode.proxy.minimal": { attempts: 1, successes: 1 },
    });
  });

  it("records best-effort proxy RPC failures without throwing", async () => {
    const client = {
      getStorageAt: vi.fn(async () => {
        throw new Error("storage unavailable");
      }),
      readContract: vi.fn(async () => {
        throw new Error("loupe unavailable");
      }),
      getCode: vi.fn(async () => {
        throw new Error("code unavailable");
      }),
    };

    await expect(detectProxy(client as any, ADDR as any)).resolves.toBeNull();
    expect(metricsSnapshot().metrics).toMatchObject({
      "rpc.getStorageAt.proxy.implementation_slot": {
        attempts: 1,
        failures: 1,
        last_error: "storage unavailable",
      },
      "rpc.getStorageAt.proxy.beacon_slot": {
        attempts: 1,
        failures: 1,
        last_error: "storage unavailable",
      },
      "rpc.getCode.proxy.minimal": {
        attempts: 1,
        failures: 1,
        last_error: "code unavailable",
      },
      "rpc.readContract.proxy.diamond_facets": {
        attempts: 1,
        misses: 1,
      },
    });
  });
});
