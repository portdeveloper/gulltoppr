import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeClient = {
  getCode: vi.fn(async () => "0x60016001" as `0x${string}`),
  readContract: vi.fn(async () => {
    throw new Error("not erc20");
  }),
};

vi.mock("../src/clients.js", () => ({
  getClient: vi.fn(() => ({ client: fakeClient, resolved: { id: 1, chain: {}, rpcUrl: "http://rpc" } })),
}));
vi.mock("../src/resolve/proxy.js", () => ({ detectProxy: vi.fn(async () => null) }));
vi.mock("../src/resolve/etherscan.js", () => ({
  fromEtherscan: vi.fn(async () => ({
    abi: [
      {
        type: "function",
        name: "balanceOf",
        stateMutability: "view",
        inputs: [{ name: "owner", type: "address" }],
        outputs: [{ name: "", type: "uint256" }],
      },
      {
        type: "function",
        name: "symbol",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "string" }],
      },
      {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
        outputs: [],
      },
      {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
        outputs: [],
      },
    ],
    natspec: true,
    isProxy: false,
  })),
}));
vi.mock("../src/resolve/sourcify.js", () => ({ fromSourcify: vi.fn(async () => null) }));
vi.mock("../src/resolve/heimdall.js", () => ({ fromHeimdall: vi.fn(async () => null), decodeTxViaHeimdall: vi.fn() }));
vi.mock("../src/resolve/fourbyte.js", () => ({ fromFourByte: vi.fn(async () => null) }));
vi.mock("../src/registry/propose.js", () => ({ proposeAndVerify: vi.fn(async () => 0) }));

import { app } from "../src/server.js";
import { fromEtherscan } from "../src/resolve/etherscan.js";

describe("compact resolve_abi HTTP responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fakeClient.getCode.mockResolvedValue("0x60016001");
    fakeClient.readContract.mockRejectedValue(new Error("not erc20"));
  });

  it("omits raw ABI when include_abi=false", async () => {
    const res = await app.request("/v1/ethereum/0x0000000000000000000000000000000000000c01/abi?include_abi=false");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("x-abi-included")).toBe("false");
    expect(Number(res.headers.get("x-elapsed-ms"))).toBeGreaterThanOrEqual(0);
    expect(body).not.toHaveProperty("abi");
    expect(body).toMatchObject({
      abi_omitted: true,
      interface: {
        reads: expect.arrayContaining([expect.objectContaining({ function: "balanceOf" })]),
        writes: expect.arrayContaining([expect.objectContaining({ function: "transfer" })]),
      },
      provenance: { source: "etherscan", confidence: "verified" },
    });
  });

  it("filters compact manifests by method text, kind, and limit", async () => {
    const res = await app.request(
      "/v1/ethereum/0x0000000000000000000000000000000000000c04/abi?include_abi=false&method_q=spender&method_kind=write&method_limit=1",
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).not.toHaveProperty("abi");
    expect(body.interface).toEqual({
      reads: [],
      writes: [expect.objectContaining({ function: "approve", signature: "approve(address,uint256)" })],
    });
  });

  it("keeps raw ABI by default for backwards-compatible REST callers", async () => {
    const res = await app.request("/v1/ethereum/0x0000000000000000000000000000000000000c02/abi");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get("x-abi-included")).toBe("true");
    expect(body.abi).toEqual(expect.arrayContaining([expect.objectContaining({ name: "balanceOf" })]));
    expect(body).not.toHaveProperty("abi_omitted");
  });

  it("rejects invalid include_abi before running resolver rungs", async () => {
    const res = await app.request("/v1/ethereum/0x0000000000000000000000000000000000000c03/abi?include_abi=maybe");
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("INVALID_ARGS");
    expect(fromEtherscan).not.toHaveBeenCalled();
  });

  it("rejects invalid method filters before running resolver rungs", async () => {
    const res = await app.request("/v1/ethereum/0x0000000000000000000000000000000000000c05/abi?method_kind=event");
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe("INVALID_ARGS");
    expect(fromEtherscan).not.toHaveBeenCalled();
  });
});
