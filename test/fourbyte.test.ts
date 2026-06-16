import { describe, it, expect, vi, afterEach } from "vitest";
import { toFunctionSelector } from "viem";
import { extractSelectors, fromFourByte } from "../src/resolve/fourbyte.js";
import { registry } from "../src/registry/store.js";
import { metricsSnapshot, resetMetricsForTests } from "../src/metrics.js";

afterEach(() => {
  vi.unstubAllGlobals();
  resetMetricsForTests();
});

describe("rung 5: selector extraction (PUSH4 dispatcher scan)", () => {
  it("collects PUSH4 operands and skips selectors embedded in other PUSH data", () => {
    // PUSH1 80, PUSH1 40, MSTORE, PUSH4 a9059cbb, EQ,
    // PUSH32 <data containing 63deadbeef — must NOT be read as code>, PUSH4 70a08231
    const code = ("0x6080604052" +
      "63a9059cbb" + "14" +
      "7f" + "63deadbeef".padEnd(64, "0") +
      "6370a08231") as `0x${string}`;
    const sels = extractSelectors(code);
    expect(sels).toContain("0xa9059cbb");
    expect(sels).toContain("0x70a08231");
    expect(sels).not.toContain("0xdeadbeef");
  });

  it("filters ffffffff/00000000 and handles empty code", () => {
    expect(extractSelectors("0x63ffffffff6300000000")).toEqual([]);
    expect(extractSelectors("0x")).toEqual([]);
  });
});

describe("rung 5: registry-first naming, 4byte fallback", () => {
  it("names selectors from the registry first, 4byte second, Unresolved_ last", async () => {
    const provenSelector = toFunctionSelector("provenName(uint256)");
    const fourbyteSelector = toFunctionSelector("fourByteName(address)");
    registry.recordProven({ selector: provenSelector, kind: "function", signature: "provenName(uint256)" });

    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).includes(`hex_signature=${fourbyteSelector}`)) {
        return new Response(JSON.stringify({ results: [{ text_signature: "fourByteName(address)" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }));

    // three PUSH4s: registry-known, 4byte-known, unknown
    const code = `0x63${provenSelector.slice(2)}1463${fourbyteSelector.slice(2)}1463cccc333314` as `0x${string}`;
    const r = await fromFourByte(code);
    expect(r).not.toBeNull();
    const names = r!.abi.map((i: any) => i.name);
    expect(names).toContain("provenName");
    expect(names).toContain("fourByteName");
    expect(names).toContain("Unresolved_cccc3333");
    expect(r!.counts).toEqual({ registry: 1, fourbyte: 1, unresolved: 1 });
    expect(metricsSnapshot().metrics["rung.4byte.directory"]).toMatchObject({
      attempts: 2,
      successes: 1,
      misses: 1,
    });
  });

  it("ignores public 4byte labels that do not hash back to the selector", async () => {
    const selector = "0xbbbb2222";
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ text_signature: "fourByteName(address)" }] }), { status: 200 }),
    ));

    const r = await fromFourByte(`0x63${selector.slice(2)}14` as `0x${string}`);

    expect((r!.abi[0] as any).name).toBe("Unresolved_bbbb2222");
    expect(r!.counts).toEqual({ registry: 0, fourbyte: 0, unresolved: 1 });
    expect(metricsSnapshot().metrics["rung.4byte.directory"]).toMatchObject({
      attempts: 1,
      misses: 1,
    });
  });

  it("scans public 4byte results for the first label that hashes back to the selector", async () => {
    const selector = toFunctionSelector("laterValid(address)");
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({
        results: [
          { text_signature: "not a signature" },
          { text_signature: "wrongFirst(uint256)" },
          { text_signature: "laterValid(address)" },
        ],
      }), { status: 200 }),
    ));

    const r = await fromFourByte(`0x63${selector.slice(2)}14` as `0x${string}`);

    expect((r!.abi[0] as any).name).toBe("laterValid");
    expect(r!.counts).toEqual({ registry: 0, fourbyte: 1, unresolved: 0 });
    expect(metricsSnapshot().metrics["rung.4byte.directory"]).toMatchObject({
      attempts: 1,
      successes: 1,
    });
  });

  it("does not let public 4byte labels override proven registry ambiguity", async () => {
    const selector = "0x77dbd42e";
    registry.recordProven({ selector, kind: "function", signature: "f38491(uint256)" });
    registry.recordProven({ selector, kind: "function", signature: "f116643(uint256)" });
    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ text_signature: "f38491(uint256)" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);

    const r = await fromFourByte(`0x63${selector.slice(2)}14` as `0x${string}`);

    expect((r!.abi[0] as any).name).toBe("Unresolved_77dbd42e");
    expect(r!.counts).toEqual({ registry: 0, fourbyte: 0, unresolved: 1 });
    expect(fetch).not.toHaveBeenCalled();
    expect(metricsSnapshot().metrics["rung.4byte.directory"]).toBeUndefined();
  });

  it("returns null for missing/empty code or no selectors", async () => {
    expect(await fromFourByte(undefined)).toBeNull();
    expect(await fromFourByte("0x")).toBeNull();
    expect(await fromFourByte("0x6080604052")).toBeNull(); // no PUSH4s
  });

  it("survives a 4byte.directory outage (network error → Unresolved_)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    const r = await fromFourByte("0x63dddd444414" as `0x${string}`);
    expect((r!.abi[0] as any).name).toBe("Unresolved_dddd4444");
    expect(r!.counts.unresolved).toBe(1);
    expect(metricsSnapshot().metrics["rung.4byte.directory"]).toMatchObject({
      attempts: 1,
      failures: 1,
      last_error: "network down",
    });
  });
});
