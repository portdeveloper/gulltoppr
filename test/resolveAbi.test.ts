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

import { resolveAbi } from "../src/resolve/index.js";
import { fromEtherscan } from "../src/resolve/etherscan.js";
import { fromSourcify } from "../src/resolve/sourcify.js";
import { fromHeimdall } from "../src/resolve/heimdall.js";
import { detectProxy } from "../src/resolve/proxy.js";

const ABI = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "a", type: "uint256" }], outputs: [] },
] as const;
// Distinct addresses per test so the module-level cache doesn't bleed across cases.
const A1 = "0x0000000000000000000000000000000000000001";
const A2 = "0x0000000000000000000000000000000000000002";
const A3 = "0x0000000000000000000000000000000000000003";
const A4 = "0x0000000000000000000000000000000000000004";
const A5 = "0x0000000000000000000000000000000000000005";
const A6 = "0x0000000000000000000000000000000000000006";
const IMPL = "0x00000000000000000000000000000000000000ff";

beforeEach(() => {
  vi.clearAllMocks(); // reset call history; arm known defaults below
  vi.mocked(fromEtherscan).mockResolvedValue(null);
  vi.mocked(fromSourcify).mockResolvedValue(null);
  vi.mocked(fromHeimdall).mockResolvedValue(null);
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

  it("proxy: resolves implementation ABI, caps confidence to partial", async () => {
    vi.mocked(detectProxy).mockResolvedValue({ pattern: "eip1967", implementation: IMPL as any });
    vi.mocked(fromEtherscan).mockResolvedValue({ abi: ABI as any, natspec: true, isProxy: false }); // impl is verified
    const r = await resolveAbi(1, A4);
    expect(r.proxy?.pattern).toBe("eip1967");
    expect(r.abi_for).toBe(IMPL);
    expect(r.provenance).toMatchObject({ source: "proxy-impl", confidence: "partial", verified: false });
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
    expect(vi.mocked(fromHeimdall)).not.toHaveBeenCalled();
  });
});
