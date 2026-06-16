import { beforeEach, describe, expect, it, vi } from "vitest";
import { simulate } from "../src/verbs/simulate.js";
import { metricsSnapshot, resetMetricsForTests } from "../src/metrics.js";

const FROM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const TO = "0x0000000000000000000000000000000000000001";

describe("simulate", () => {
  beforeEach(() => resetMetricsForTests());

  it("includes native value transfers in asset_changes", async () => {
    const client = {
      call: vi.fn(async () => ({ data: "0x" })),
      estimateGas: vi.fn(async () => 21_000n),
      request: vi.fn(async () => {
        throw new Error("debug_traceCall unsupported");
      }),
    };

    const result = await simulate(client as any, {
      from: FROM,
      to: TO,
      data: "0x",
      value: "123",
    });

    expect(result.success).toBe(true);
    expect(result.asset_changes).toContainEqual({
      address: FROM,
      token: "0x0000000000000000000000000000000000000000",
      delta: "-123",
      kind: "native",
    });
    expect(metricsSnapshot().metrics).toMatchObject({
      "rpc.eth_call.simulate": { attempts: 1, successes: 1 },
      "rpc.estimateGas.simulate": { attempts: 1, successes: 1 },
      "rpc.debug_traceCall.callTracer": { attempts: 1, misses: 1 },
      "rpc.debug_traceCall.prestateTracer": { attempts: 1, misses: 1 },
    });
  });

  it("canonicalizes decimal value strings before tracing and asset accounting", async () => {
    const traceValues: unknown[] = [];
    const client = {
      call: vi.fn(async () => ({ data: "0x" })),
      estimateGas: vi.fn(async () => 21_000n),
      request: vi.fn(async ({ params }: { params: any[] }) => {
        traceValues.push(params[0]?.value);
        return { gasUsed: "0x5208", logs: [] };
      }),
    };

    const result = await simulate(client as any, {
      from: FROM,
      to: TO,
      data: "0x",
      value: "00123",
    });

    expect(client.call).toHaveBeenCalledWith({ account: FROM, to: TO, data: "0x", value: 123n });
    expect(client.estimateGas).toHaveBeenCalledWith({ account: FROM, to: TO, data: "0x", value: 123n });
    expect(traceValues).toEqual(["0x7b", "0x7b"]);
    expect(result.asset_changes).toContainEqual({
      address: FROM,
      token: "0x0000000000000000000000000000000000000000",
      delta: "-123",
      kind: "native",
    });
  });

  it("rejects invalid direct value strings before RPC calls", async () => {
    const client = {
      call: vi.fn(),
      estimateGas: vi.fn(),
      request: vi.fn(),
    };

    await expect(simulate(client as any, {
      from: FROM,
      to: TO,
      data: "0x",
      value: "1.5",
    })).rejects.toMatchObject({
      code: "INVALID_ARGS",
      message: "`value` must be a decimal string in wei.",
    });
    expect(client.call).not.toHaveBeenCalled();
    expect(client.estimateGas).not.toHaveBeenCalled();
    expect(client.request).not.toHaveBeenCalled();
  });

  it("populates state_diff from prestateTracer diffMode when supported", async () => {
    const client = {
      call: vi.fn(async () => ({ data: "0x" })),
      estimateGas: vi.fn(async () => 21_000n),
      request: vi.fn(async ({ params }: { params: any[] }) => {
        const tracer = params[2]?.tracer;
        if (tracer === "callTracer") return { gasUsed: "0x5208", logs: [] };
        if (tracer === "prestateTracer") {
          return {
            pre: {
              [TO]: {
                balance: "0x1",
                nonce: 7,
                storage: {
                  "0x01": "0x10",
                  "0x02": "0x20",
                },
              },
            },
            post: {
              [TO]: {
                storage: {
                  "0x01": "0x11",
                  "0x03": "0x30",
                },
              },
            },
          };
        }
        throw new Error("unsupported tracer");
      }),
    };

    const result = await simulate(client as any, {
      from: FROM,
      to: TO,
      data: "0x",
    });

    expect(result.state_diff).toEqual([
      { address: TO, slot_label: "0x01", before: "0x10", after: "0x11" },
      { address: TO, slot_label: "0x02", before: "0x20", after: "0x0" },
      { address: TO, slot_label: "0x03", before: "0x0", after: "0x30" },
    ]);
    expect(result.state_diff).not.toContainEqual(expect.objectContaining({ slot_label: "balance" }));
    expect(result.state_diff).not.toContainEqual(expect.objectContaining({ slot_label: "nonce" }));
    expect(metricsSnapshot().metrics).toMatchObject({
      "rpc.debug_traceCall.callTracer": { attempts: 1, successes: 1 },
      "rpc.debug_traceCall.prestateTracer": { attempts: 1, successes: 1 },
    });
  });
});
