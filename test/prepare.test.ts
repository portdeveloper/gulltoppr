import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Abi } from "viem";

const mocks = vi.hoisted(() => ({
  resolveAbiInternal: vi.fn(),
  simulate: vi.fn(),
}));

vi.mock("../src/resolve/index.js", () => ({
  resolveAbiInternal: mocks.resolveAbiInternal,
}));

vi.mock("../src/verbs/simulate.js", () => ({
  simulate: mocks.simulate,
  requireFrom: (from: string | undefined) => {
    if (!from || !/^0x[0-9a-fA-F]{40}$/.test(from)) throw new Error("bad from");
    return from;
  },
}));

import { prepareTx } from "../src/verbs/prepare.js";

const FROM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const TO = "0x0000000000000000000000000000000000000001";
const CONTRACT = "0x0000000000000000000000000000000000000002";

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
  {
    type: "function",
    name: "batch",
    stateMutability: "nonpayable",
    inputs: [{ name: "amounts", type: "uint256[]" }],
    outputs: [],
  },
] as const satisfies Abi;

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "increaseAllowance",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "addedValue", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  ...ABI,
] as const satisfies Abi;

const ERC721_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const ERC1155_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "id", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "safeBatchTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "ids", type: "uint256[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const baseResolution = {
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
};

const successSim = {
  success: true,
  gas_used: 21_000,
  return_value: { decoded: [], raw: "0x" },
  state_diff: [],
  asset_changes: [],
  logs: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveAbiInternal.mockResolvedValue(baseResolution);
  mocks.simulate.mockResolvedValue(successSim);
});

describe("prepareTx safety", () => {
  it("marks verified successful writes as low risk with a signing deeplink", async () => {
    const r = await prepareTx({ chain: 1, address: CONTRACT, function: "transfer", args: [TO, "1"], from: FROM });

    expect(r.simulation.success).toBe(true);
    expect(r.deeplink).toContain("https://abi.ninja/1/");
    expect(r.wallet_request).toEqual({
      chainId: 1,
      method: "eth_sendTransaction",
      params: [
        {
          from: FROM,
          to: CONTRACT,
          data: r.unsigned_tx.data,
          value: "0x0",
          gas: "0x6270",
        },
      ],
    });
    expect(r.warnings).toEqual([]);
    expect(r.safety).toEqual({
      signing_recommended: true,
      risk_level: "low",
      requires_human_confirmation: false,
      reasons: [],
    });
  });

  it("rejects view/pure functions before simulation or signing hand-off", async () => {
    mocks.resolveAbiInternal.mockResolvedValue({
      ...baseResolution,
      abi: ERC20_ABI,
      functions: ERC20_ABI,
    });

    await expect(prepareTx({ chain: 1, address: CONTRACT, function: "balanceOf", args: [FROM], from: FROM })).rejects.toMatchObject({
      code: "NOT_A_WRITE_FN",
      message: expect.stringContaining("use read_contract"),
    });
    expect(mocks.simulate).not.toHaveBeenCalled();
  });

  it("marks decompiled or selector-only writes as high-friction", async () => {
    mocks.resolveAbiInternal.mockResolvedValue({
      ...baseResolution,
      provenance: {
        source: "heimdall-decompiled",
        confidence: "decompiled",
        verified: false,
        names_synthetic: true,
        natspec: false,
      },
    });

    const r = await prepareTx({ chain: 1, address: CONTRACT, function: "transfer", args: [TO, "1"], from: FROM });

    expect(r.safety).toMatchObject({
      signing_recommended: true,
      risk_level: "high",
      requires_human_confirmation: true,
      reasons: ["abi_names_inferred"],
    });
    expect(r.warnings.join(" ")).toContain("High-friction write");
    expect(r.warnings.join(" ")).toContain("confirm the selector and intent");
  });

  it("keeps low-confidence writes high-friction even when names are recovered", async () => {
    for (const confidence of ["decompiled", "selector-only"] as const) {
      vi.clearAllMocks();
      mocks.resolveAbiInternal.mockResolvedValue({
        ...baseResolution,
        provenance: {
          source: confidence === "decompiled" ? "heimdall-decompiled" : "4byte",
          confidence,
          verified: false,
          names_synthetic: false,
          natspec: false,
        },
      });
      mocks.simulate.mockResolvedValue(successSim);

      const r = await prepareTx({ chain: 1, address: CONTRACT, function: "transfer", args: [TO, "1"], from: FROM });

      expect(r.safety).toMatchObject({
        signing_recommended: true,
        risk_level: "high",
        requires_human_confirmation: true,
        reasons: ["abi_names_inferred"],
      });
      expect(r.warnings.join(" ")).toContain(`ABI confidence is ${confidence}`);
    }
  });

  it("marks proxy writes as human-confirmed medium risk while still targeting the proxy", async () => {
    mocks.resolveAbiInternal.mockResolvedValue({
      ...baseResolution,
      abiFor: "0x00000000000000000000000000000000000000ff",
      proxy: {
        is_proxy: true,
        pattern: "eip1967",
        hops: [
          { address: CONTRACT, role: "proxy" },
          { address: "0x00000000000000000000000000000000000000ff", role: "implementation" },
        ],
        resolved_implementation: "0x00000000000000000000000000000000000000ff",
      },
    });

    const r = await prepareTx({ chain: 1, address: CONTRACT, function: "transfer", args: [TO, "1"], from: FROM });

    expect(r.unsigned_tx.to).toBe(CONTRACT);
    expect(r.wallet_request?.params[0].to).toBe(CONTRACT);
    expect(r.safety).toMatchObject({
      signing_recommended: true,
      risk_level: "medium",
      requires_human_confirmation: true,
      reasons: ["proxy"],
    });
    expect(r.warnings.join(" ")).toContain("Target is a eip1967 proxy");
    expect(r.warnings.join(" ")).toContain("0x00000000000000000000000000000000000000ff");
  });

  it("marks native-value writes as human-confirmed medium risk", async () => {
    const r = await prepareTx({
      chain: 1,
      address: CONTRACT,
      function: "transfer",
      args: [TO, "1"],
      from: FROM,
      value: "123",
    });

    expect(r.unsigned_tx.value).toBe("123");
    expect(r.human_summary).toContain("with 123 wei native value");
    expect(r.wallet_request?.params[0].value).toBe("0x7b");
    expect(r.safety).toMatchObject({
      signing_recommended: true,
      risk_level: "medium",
      requires_human_confirmation: true,
      reasons: ["native_value"],
    });
    expect(r.warnings.join(" ")).toContain("Sends 123 wei of native value.");
  });

  it("canonicalizes native value before safety checks and wallet hand-off", async () => {
    const zero = await prepareTx({
      chain: 1,
      address: CONTRACT,
      function: "transfer",
      args: [TO, "1"],
      from: FROM,
      value: "000",
    });
    expect(zero.unsigned_tx.value).toBe("0");
    expect(zero.wallet_request?.params[0].value).toBe("0x0");
    expect(zero.human_summary).not.toContain("native value");
    expect(zero.safety.reasons).not.toContain("native_value");

    const nonzero = await prepareTx({
      chain: 1,
      address: CONTRACT,
      function: "transfer",
      args: [TO, "1"],
      from: FROM,
      value: "00123",
    });
    expect(nonzero.unsigned_tx.value).toBe("123");
    expect(nonzero.wallet_request?.params[0].value).toBe("0x7b");
    expect(nonzero.human_summary).toContain("with 123 wei native value");
    expect(nonzero.warnings.join(" ")).toContain("Sends 123 wei of native value.");
    expect(nonzero.safety.reasons).toContain("native_value");
  });

  it("rejects invalid direct prepare_tx value strings", async () => {
    await expect(
      prepareTx({
        chain: 1,
        address: CONTRACT,
        function: "transfer",
        args: [TO, "1"],
        from: FROM,
        value: "1.5",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_ARGS",
      message: "`value` must be a decimal string in wei.",
    });
    expect(mocks.simulate).not.toHaveBeenCalled();
  });

  it("marks simulated token outflows from the sender as human-confirmed medium risk", async () => {
    mocks.simulate.mockResolvedValue({
      ...successSim,
      asset_changes: [
        {
          address: FROM,
          token: CONTRACT,
          symbol: "TOK",
          delta: "-42",
          kind: "erc20",
        },
      ],
    });

    const r = await prepareTx({ chain: 1, address: CONTRACT, function: "transfer", args: [TO, "42"], from: FROM });

    expect(r.safety).toMatchObject({
      signing_recommended: true,
      risk_level: "medium",
      requires_human_confirmation: true,
      reasons: ["asset_outflow"],
    });
    expect(r.warnings.join(" ")).toContain("Simulation shows -42 TOK erc20 outflow");
    expect(r.wallet_request).toBeDefined();
  });

  it("infers standard ERC20 transfer outflows when trace asset changes are unavailable", async () => {
    mocks.resolveAbiInternal.mockResolvedValue({
      ...baseResolution,
      abi: ERC20_ABI,
      functions: ERC20_ABI,
    });

    const r = await prepareTx({ chain: 1, address: CONTRACT, function: "transfer", args: [TO, "42"], from: FROM });

    expect(r.simulation.asset_changes).toEqual([]);
    expect(r.safety).toMatchObject({
      signing_recommended: true,
      risk_level: "medium",
      requires_human_confirmation: true,
      reasons: ["asset_outflow"],
    });
    expect(r.warnings.join(" ")).toContain(`Call transfers 42 erc20 units from ${FROM} to ${TO} (${CONTRACT})`);
  });

  it("infers standard ERC721 transfer outflows when trace asset changes are unavailable", async () => {
    mocks.resolveAbiInternal.mockResolvedValue({
      ...baseResolution,
      abi: ERC721_ABI,
      functions: ERC721_ABI,
    });

    const r = await prepareTx({ chain: 1, address: CONTRACT, function: "transferFrom", args: [FROM, TO, "0"], from: FROM });

    expect(r.safety).toMatchObject({
      signing_recommended: true,
      risk_level: "medium",
      requires_human_confirmation: true,
      reasons: ["asset_outflow"],
    });
    expect(r.warnings.join(" ")).toContain(`Call transfers erc721 token 0 from ${FROM} to ${TO} (${CONTRACT})`);
  });

  it("infers standard ERC1155 transfer outflows when trace asset changes are unavailable", async () => {
    mocks.resolveAbiInternal.mockResolvedValue({
      ...baseResolution,
      abi: ERC1155_ABI,
      functions: ERC1155_ABI,
    });

    const r = await prepareTx({
      chain: 1,
      address: CONTRACT,
      function: "safeTransferFrom(address,address,uint256,uint256,bytes)",
      args: [FROM, TO, "7", "2", "0x"],
      from: FROM,
    });

    expect(r.safety).toMatchObject({
      signing_recommended: true,
      risk_level: "medium",
      requires_human_confirmation: true,
      reasons: ["asset_outflow"],
    });
    expect(r.warnings.join(" ")).toContain(`Call transfers 2 erc1155 units of token 7 from ${FROM} to ${TO} (${CONTRACT})`);
  });

  it("infers standard ERC1155 batch transfer outflows when trace asset changes are unavailable", async () => {
    mocks.resolveAbiInternal.mockResolvedValue({
      ...baseResolution,
      abi: ERC1155_ABI,
      functions: ERC1155_ABI,
    });

    const r = await prepareTx({
      chain: 1,
      address: CONTRACT,
      function: "safeBatchTransferFrom",
      args: [FROM, TO, ["1", "2"], ["3", "4"], "0x"],
      from: FROM,
    });

    expect(r.safety).toMatchObject({
      signing_recommended: true,
      risk_level: "medium",
      requires_human_confirmation: true,
      reasons: ["asset_outflow"],
    });
    expect(r.warnings.join(" ")).toContain(
      `Call transfers erc1155 batch from ${FROM} to ${TO} (${CONTRACT}): ids [1,2], amounts [3,4].`,
    );
  });

  it("marks ERC20 spender approvals as human-confirmed medium risk", async () => {
    mocks.resolveAbiInternal.mockResolvedValue({
      ...baseResolution,
      abi: ERC20_ABI,
      functions: ERC20_ABI,
    });

    const r = await prepareTx({ chain: 1, address: CONTRACT, function: "approve", args: [TO, "42"], from: FROM });

    expect(r.safety).toMatchObject({
      signing_recommended: true,
      risk_level: "medium",
      requires_human_confirmation: true,
      reasons: ["spending_approval"],
    });
    expect(r.warnings.join(" ")).toContain(`Call approves ${TO} to spend 42 erc20 units from the signer (${CONTRACT})`);
  });

  it("keeps ERC20 zero approvals low risk because they revoke allowance", async () => {
    mocks.resolveAbiInternal.mockResolvedValue({
      ...baseResolution,
      abi: ERC20_ABI,
      functions: ERC20_ABI,
    });

    const r = await prepareTx({ chain: 1, address: CONTRACT, function: "approve", args: [TO, "0"], from: FROM });

    expect(r.warnings).toEqual([]);
    expect(r.safety).toMatchObject({
      signing_recommended: true,
      risk_level: "low",
      requires_human_confirmation: false,
      reasons: [],
    });
  });

  it("marks ERC721 per-token approvals as human-confirmed medium risk", async () => {
    mocks.resolveAbiInternal.mockResolvedValue({
      ...baseResolution,
      abi: ERC721_ABI,
      functions: ERC721_ABI,
    });

    const r = await prepareTx({ chain: 1, address: CONTRACT, function: "approve", args: [TO, "0"], from: FROM });

    expect(r.safety).toMatchObject({
      signing_recommended: true,
      risk_level: "medium",
      requires_human_confirmation: true,
      reasons: ["spending_approval"],
    });
    expect(r.warnings.join(" ")).toContain(`Call approves ${TO} to transfer erc721 token 0 (${CONTRACT})`);
  });

  it("marks collection-wide approvals as human-confirmed medium risk", async () => {
    mocks.resolveAbiInternal.mockResolvedValue({
      ...baseResolution,
      abi: ERC1155_ABI,
      functions: ERC1155_ABI,
    });

    const r = await prepareTx({ chain: 1, address: CONTRACT, function: "setApprovalForAll", args: [TO, true], from: FROM });

    expect(r.safety).toMatchObject({
      signing_recommended: true,
      risk_level: "medium",
      requires_human_confirmation: true,
      reasons: ["spending_approval"],
    });
    expect(r.warnings.join(" ")).toContain(`Call approves ${TO} to transfer all tokens for this collection (${CONTRACT})`);
  });

  it("keeps collection-wide approval revocations low risk", async () => {
    mocks.resolveAbiInternal.mockResolvedValue({
      ...baseResolution,
      abi: ERC721_ABI,
      functions: ERC721_ABI,
    });

    const r = await prepareTx({ chain: 1, address: CONTRACT, function: "setApprovalForAll", args: [TO, false], from: FROM });

    expect(r.warnings).toEqual([]);
    expect(r.safety).toMatchObject({
      signing_recommended: true,
      risk_level: "low",
      requires_human_confirmation: false,
      reasons: [],
    });
  });

  it("renders human summaries for nested bigint arguments", async () => {
    const r = await prepareTx({ chain: 1, address: CONTRACT, function: "batch", args: [["1", "2"]], from: FROM });

    expect(r.human_summary).toContain('batch(uint256[])(["1","2"])');
    expect(r.safety.risk_level).toBe("low");
  });

  it("blocks signing recommendations and deeplinks when simulation fails", async () => {
    mocks.simulate.mockResolvedValue({
      ...successSim,
      success: false,
      gas_used: 0,
      return_value: undefined,
      revert: { reason: "ERC20: transfer amount exceeds balance" },
    });

    const r = await prepareTx({ chain: 1, address: CONTRACT, function: "transfer", args: [TO, "1"], from: FROM });

    expect(r.deeplink).toBe("");
    expect(r.wallet_request).toBeUndefined();
    expect(r.safety).toMatchObject({
      signing_recommended: false,
      risk_level: "blocked",
      requires_human_confirmation: true,
      reasons: ["simulation_failed"],
    });
    expect(r.warnings.join(" ")).toContain("do not send this transaction");
  });
});
