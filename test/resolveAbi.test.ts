import { describe, it, expect, vi, beforeEach } from "vitest";

// Fake viem client: a contract exists (getCode non-empty); token detection misses.
// Bytecode is per-address by default so the registry's bytecode-match rung
// (which keys on skeleton hash) doesn't fire across unrelated test cases.
const codeFor = (address: string) => ("0x6001" + address.slice(-4)) as `0x${string}`;
const fakeClient = {
  getCode: vi.fn(async ({ address }: { address: string }) => codeFor(address)),
  readContract: vi.fn(async () => {
    throw new Error("not erc20");
  }),
};

vi.mock("../src/clients.js", () => ({
  getClient: vi.fn(() => ({ client: fakeClient, resolved: { id: 1, chain: {}, rpcUrl: "http://rpc" } })),
}));
vi.mock("../src/resolve/proxy.js", () => ({ detectProxy: vi.fn(async () => null) }));
vi.mock("../src/resolve/etherscan.js", () => ({ fromEtherscan: vi.fn(async () => null) }));
vi.mock("../src/resolve/sourcify.js", () => ({ fromSourcify: vi.fn(async () => null) }));
vi.mock("../src/resolve/heimdall.js", () => ({ fromHeimdall: vi.fn(async () => null), decodeTxViaHeimdall: vi.fn() }));
vi.mock("../src/resolve/fourbyte.js", () => ({ fromFourByte: vi.fn(async () => null) }));
// Never let the fire-and-forget LLM pass make real API calls from tests.
vi.mock("../src/registry/propose.js", () => ({ proposeAndVerify: vi.fn(async () => 0) }));

import { cacheTtlForAbi, compactAbiResult, resolveAbi } from "../src/resolve/index.js";
import { fromEtherscan } from "../src/resolve/etherscan.js";
import { fromSourcify } from "../src/resolve/sourcify.js";
import { fromHeimdall } from "../src/resolve/heimdall.js";
import { detectProxy } from "../src/resolve/proxy.js";
import { fromFourByte } from "../src/resolve/fourbyte.js";
import { getClient } from "../src/clients.js";
import { metricsSnapshot, resetMetricsForTests } from "../src/metrics.js";
import { getAddress } from "viem";

const ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "a", type: "uint256" }], outputs: [] },
] as const;
const BALANCE_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;
const APPROVE_ABI = [
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "a", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;
// Distinct addresses per test so the module-level cache doesn't bleed across cases.
const A1 = "0x0000000000000000000000000000000000000001";
const A2 = "0x0000000000000000000000000000000000000002";
const A3 = "0x0000000000000000000000000000000000000003";
const A4 = "0x0000000000000000000000000000000000000004";
const A5 = "0x0000000000000000000000000000000000000005";
const A6 = "0x0000000000000000000000000000000000000006";
const A8 = "0x0000000000000000000000000000000000000008";
const A9 = "0x0000000000000000000000000000000000000009";
const IMPL = "0x00000000000000000000000000000000000000ff";
const FACET1 = "0x00000000000000000000000000000000000000f1";
const FACET2 = "0x00000000000000000000000000000000000000f2";

beforeEach(() => {
  resetMetricsForTests();
  vi.clearAllMocks(); // reset call history; arm known defaults below
  vi.mocked(getClient).mockImplementation((_chainInput, rpcOverride) => ({
    client: fakeClient as any,
    resolved: { id: 1, chain: {} as any, rpcUrl: rpcOverride ?? "http://rpc" },
  }));
  vi.mocked(fromEtherscan).mockResolvedValue(null);
  vi.mocked(fromSourcify).mockResolvedValue(null);
  vi.mocked(fromHeimdall).mockResolvedValue(null);
  vi.mocked(fromFourByte).mockResolvedValue(null);
  vi.mocked(detectProxy).mockResolvedValue(null);
  fakeClient.getCode.mockImplementation(async ({ address }: { address: string }) => codeFor(address));
  fakeClient.readContract.mockRejectedValue(new Error("not erc20"));
});

describe("resolveAbi ladder + provenance", () => {
  it("rung 1: verified via Etherscan", async () => {
    vi.mocked(fromEtherscan).mockResolvedValue({ abi: ABI as any, natspec: true, isProxy: false });
    const r = await resolveAbi(1, A1);
    expect(r.provenance).toMatchObject({ source: "etherscan", confidence: "verified", verified: true });
    expect(r.abi_for).toBe(A1);
    expect(r.interface.writes.map((w) => w.function)).toContain("transfer");
  });

  it("records resolver metrics for code lookup, proxy detection, and source rungs", async () => {
    const address = "0x00000000000000000000000000000000000000d1";
    vi.mocked(fromEtherscan).mockResolvedValue({ abi: ABI as any, natspec: true, isProxy: false });

    await resolveAbi(1, address);

    expect(metricsSnapshot().metrics).toMatchObject({
      "rpc.getCode": { attempts: 1, successes: 1 },
      "rung.proxy_detection": { attempts: 1, misses: 1 },
      "rung.etherscan": { attempts: 1, successes: 1 },
    });
  });

  it("uses provenance-aware cache TTLs aligned with REST Cache-Control", () => {
    expect(cacheTtlForAbi({
      provenance: { confidence: "verified" },
    } as any)).toBe(86_400);
    expect(cacheTtlForAbi({
      provenance: { confidence: "partial" },
    } as any)).toBe(3_600);
    expect(cacheTtlForAbi({
      provenance: { confidence: "decompiled", names_synthetic: true },
    } as any)).toBe(3_600);
    expect(cacheTtlForAbi({
      provenance: { confidence: "selector-only", names_synthetic: true },
    } as any)).toBe(3_600);
    expect(cacheTtlForAbi({
      proxy: { is_proxy: true },
      provenance: { confidence: "verified" },
    } as any)).toBe(300);
  });

  it("can compact a resolved ABI by omitting the raw ABI", async () => {
    vi.mocked(fromEtherscan).mockResolvedValue({ abi: ABI as any, natspec: true, isProxy: false });
    const r = await resolveAbi(1, "0x00000000000000000000000000000000000000c1");
    const compact = compactAbiResult(r);

    expect(compact).not.toHaveProperty("abi");
    expect(compact).toMatchObject({
      abi_omitted: true,
      address: r.address,
      interface: r.interface,
      provenance: r.provenance,
      abi_for: r.abi_for,
    });
  });

  it("rung 2: Sourcify partial match", async () => {
    vi.mocked(fromSourcify).mockResolvedValue({ abi: ABI as any, match: "partial" });
    const r = await resolveAbi(1, A2);
    expect(r.provenance).toMatchObject({ source: "sourcify", confidence: "partial", verified: false });
  });

  it("rung 4: heimdall decompiled (names synthetic)", async () => {
    vi.mocked(fromHeimdall).mockResolvedValue({ abi: ABI as any, cached: false });
    const r = await resolveAbi(1, A3);
    expect(r.provenance).toMatchObject({ source: "heimdall-decompiled", confidence: "decompiled", names_synthetic: true });
  });

  it("rung 5: falls back to selector-only ABI when heimdall fails", async () => {
    const A7 = "0x0000000000000000000000000000000000000007";
    vi.mocked(fromHeimdall).mockRejectedValue(new Error("decompiler down"));
    vi.mocked(fromFourByte).mockResolvedValue({
      abi: ABI as any,
      counts: { registry: 1, fourbyte: 0, unresolved: 0 },
    });
    const r = await resolveAbi(1, A7);
    expect(r.provenance).toMatchObject({ source: "4byte", confidence: "selector-only", verified: false });
    expect(r.interface.writes.map((w) => w.function)).toContain("transfer");
    expect(metricsSnapshot().metrics).toMatchObject({
      "rung.etherscan": { attempts: 1, misses: 1 },
      "rung.sourcify": { attempts: 1, misses: 1 },
      "rung.heimdall": { attempts: 1, failures: 1, last_error: "decompiler down" },
      "rung.4byte": { attempts: 1, successes: 1 },
    });
  });

  it("proxy: resolves implementation ABI, caps confidence to partial", async () => {
    vi.mocked(detectProxy).mockResolvedValue({ pattern: "eip1967", implementation: IMPL as any });
    vi.mocked(fromEtherscan).mockResolvedValue({ abi: ABI as any, natspec: true, isProxy: false }); // impl is verified
    const r = await resolveAbi(1, A4);
    expect(r.proxy?.pattern).toBe("eip1967");
    expect(r.abi_for).toBe(IMPL);
    expect(r.provenance).toMatchObject({ source: "proxy-impl", confidence: "partial", verified: false });
  });

  it("diamond proxy: merges active facet functions by selector", async () => {
    vi.mocked(detectProxy).mockResolvedValue({
      pattern: "diamond",
      facets: [
        { address: FACET1 as any, selectors: ["0xa9059cbb" as any] },
        { address: FACET2 as any, selectors: ["0x70a08231" as any] },
      ],
    });
    vi.mocked(fromEtherscan).mockImplementation(async (_chain, address) => {
      if (address === FACET1) return { abi: [...ABI, ...APPROVE_ABI] as any, natspec: true, isProxy: false };
      if (address === FACET2) return { abi: BALANCE_ABI as any, natspec: true, isProxy: false };
      return null;
    });

    const r = await resolveAbi(1, A8);
    expect(r.proxy?.pattern).toBe("diamond");
    expect(r.proxy?.resolved_implementation).toBeUndefined();
    expect(r.proxy?.hops.map((hop) => hop.role)).toEqual(["proxy", "facet", "facet"]);
    expect(r.abi_for).toBe(A8);
    expect(r.provenance).toMatchObject({ source: "proxy-impl", confidence: "partial", verified: false });
    expect(r.interface.writes.map((w) => w.function)).toEqual(["transfer"]);
    expect(r.interface.reads.map((read) => read.function)).toEqual(["balanceOf"]);
  });

  it("EOA / no bytecode → ABI_NOT_FOUND", async () => {
    fakeClient.getCode.mockResolvedValue("0x");
    await expect(resolveAbi(1, A5)).rejects.toMatchObject({ code: "ABI_NOT_FOUND" });
  });

  it("caches: second call is a hit and skips the rungs", async () => {
    vi.mocked(fromEtherscan).mockResolvedValue({ abi: ABI as any, natspec: true, isProxy: false });
    const first = await resolveAbi(1, A6);
    const second = await resolveAbi(1, A6);
    expect(first.cached).toBe(false);
    expect(second.cached).toBe(true);
    expect(vi.mocked(fromEtherscan).mock.calls.length).toBe(1);
  });

  it("caches: rpc_url overrides get separate ABI cache scopes", async () => {
    vi.mocked(fromEtherscan).mockResolvedValue({ abi: ABI as any, natspec: true, isProxy: false });

    const first = await resolveAbi(1, A9, "http://rpc-one");
    const second = await resolveAbi(1, A9, "http://rpc-two");
    const third = await resolveAbi(1, A9, "http://rpc-one");

    expect(first.cached).toBe(false);
    expect(second.cached).toBe(false);
    expect(third.cached).toBe(true);
    expect(vi.mocked(fromEtherscan).mock.calls.length).toBe(2);
  });

  it("rung 3.5: clone of a verified contract resolves via bytecode-match (confidence capped to partial)", async () => {
    const ORIGINAL = "0x00000000000000000000000000000000000000a1";
    const CLONE = "0x00000000000000000000000000000000000000a2";
    const SHARED_CODE = "0x6001beef" as `0x${string}`;
    fakeClient.getCode.mockResolvedValue(SHARED_CODE); // both addresses share bytecode

    // 1) original resolves verified via Etherscan → seeds the registry
    vi.mocked(fromEtherscan).mockResolvedValue({ abi: ABI as any, natspec: true, isProxy: false });
    await resolveAbi(1, ORIGINAL);

    // 2) clone: etherscan + sourcify miss → bytecode-match, heimdall never called
    vi.mocked(fromEtherscan).mockResolvedValue(null);
    const r = await resolveAbi(1, CLONE);
    expect(r.provenance).toMatchObject({ source: "bytecode-match", confidence: "partial", verified: false, names_synthetic: false });
    expect(r.provenance.bytecode_match).toEqual({
      chain: 1,
      address: getAddress(ORIGINAL),
      source: "etherscan",
      confidence: "verified",
    });
    expect(r.provenance.notes?.toLowerCase()).toContain(ORIGINAL.toLowerCase());
    expect(r.interface.writes.map((w) => w.function)).toContain("transfer");
    expect(vi.mocked(fromHeimdall)).not.toHaveBeenCalled();
  });

  it("rung 3.5: clone of a decompiled contract reuses the decompile (stays decompiled/synthetic)", async () => {
    const ORIGINAL = "0x00000000000000000000000000000000000000b1";
    const CLONE = "0x00000000000000000000000000000000000000b2";
    const SHARED_CODE = "0x6001cafe" as `0x${string}`;
    fakeClient.getCode.mockResolvedValue(SHARED_CODE);

    vi.mocked(fromHeimdall).mockResolvedValue({ abi: ABI as any, cached: false });
    await resolveAbi(1, ORIGINAL); // decompiled → recorded under the skeleton hash

    vi.mocked(fromHeimdall).mockClear();
    const r = await resolveAbi(1, CLONE);
    expect(r.provenance).toMatchObject({ source: "bytecode-match", confidence: "decompiled", names_synthetic: true });
    expect(r.provenance.bytecode_match).toEqual({
      chain: 1,
      address: getAddress(ORIGINAL),
      source: "heimdall-decompiled",
      confidence: "decompiled",
    });
    expect(vi.mocked(fromHeimdall)).not.toHaveBeenCalled();
  });
});
