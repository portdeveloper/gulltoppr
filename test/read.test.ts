import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFunctionResult, type Abi } from "viem";

const mocks = vi.hoisted(() => ({
  resolveAbiInternal: vi.fn(),
}));

vi.mock("../src/resolve/index.js", () => ({
  resolveAbiInternal: mocks.resolveAbiInternal,
}));

import { readContract } from "../src/verbs/read.js";

const ADDRESS = "0x0000000000000000000000000000000000000001";
const OWNER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

const ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
] as const satisfies Abi;

const rawBalance = encodeFunctionResult({
  abi: ABI,
  functionName: "balanceOf",
  result: 123n,
});

beforeEach(() => {
  vi.clearAllMocks();
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
    abiFor: ADDRESS,
    cached: false,
    chainId: 1,
    client: {
      call: vi.fn(async () => ({ data: rawBalance })),
    },
    rpcUrl: "http://rpc",
  });
});

describe("readContract", () => {
  it("returns the canonical function signature for bare-name reads", async () => {
    const result = await readContract({
      chain: 1,
      address: ADDRESS,
      function: "balanceOf",
      args: [OWNER],
    });

    expect(result.function_signature).toBe("balanceOf(address)");
    expect(result.decoded).toEqual([123n]);
    expect(result.raw).toBe(rawBalance);
  });
});
