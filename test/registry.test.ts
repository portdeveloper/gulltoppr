import { describe, it, expect } from "vitest";
import { keccak256, toFunctionSelector } from "viem";
import { stripCborMetadata, skeletonHash } from "../src/registry/normalize.js";
import { Registry, registry } from "../src/registry/store.js";
import { enrichDecompiledAbi } from "../src/registry/enrich.js";

/** Build a realistic solc CBOR metadata trailer: a2 + ipfs multihash + solc version + 2-byte length. */
function solcTrailer(digestByte: string): string {
  const blob = "a2646970667358221220" + digestByte.repeat(32) + "64736f6c6343000813"; // 51 bytes
  return blob + "0033"; // 0x33 === 51
}

const RUNTIME = "0x6080604052348015600e575f5ffd5b50";

describe("registry normalize (skeleton hash)", () => {
  it("strips the solc CBOR metadata trailer", () => {
    const code = (RUNTIME + solcTrailer("ab")) as `0x${string}`;
    expect(stripCborMetadata(code)).toBe(RUNTIME);
  });

  it("same source, different metadata digest → same skeleton hash", () => {
    const a = (RUNTIME + solcTrailer("ab")) as `0x${string}`;
    const b = (RUNTIME + solcTrailer("cd")) as `0x${string}`;
    expect(a).not.toBe(b);
    expect(skeletonHash(a)).toBe(skeletonHash(b));
    expect(skeletonHash(a)).toBe(keccak256(RUNTIME as `0x${string}`));
  });

  it("different code → different skeleton hash", () => {
    const a = (RUNTIME + solcTrailer("ab")) as `0x${string}`;
    expect(skeletonHash(a)).not.toBe(skeletonHash(("0xdeadbeef" + solcTrailer("ab")) as `0x${string}`));
  });

  it("leaves code without a trailer untouched (incl. trailing bytes that merely look like a length)", () => {
    // ends with 0010 but the 16 bytes before it are not CBOR — must not strip
    const code = ("0x" + "60016002".repeat(8) + "0010") as `0x${string}`;
    expect(stripCborMetadata(code)).toBe(code);
    expect(stripCborMetadata("0x6001")).toBe("0x6001");
    expect(stripCborMetadata("0x")).toBe("0x");
  });
});

const VERIFIED_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "InsufficientBalance", inputs: [{ name: "needed", type: "uint256" }] },
] as const;

const ADDR = "0x00000000000000000000000000000000000000aa" as const;

describe("registry store", () => {
  it("harvests function/event/error selectors from a verified ABI", () => {
    const r = new Registry();
    r.recordVerifiedAbi(1, ADDR, VERIFIED_ABI as any);

    const fn = r.lookup("0xa9059cbb"); // transfer(address,uint256)
    expect(fn).toHaveLength(1);
    expect(fn[0]).toMatchObject({ kind: "function", signature: "transfer(address,uint256)", proof: "verified-source" });
    expect((fn[0]!.abi_item as any).outputs[0].type).toBe("bool");

    // Transfer(address,address,uint256) — full 32-byte topic0
    const ev = r.lookup("0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef");
    expect(ev[0]).toMatchObject({ kind: "event", signature: "Transfer(address,address,uint256)", proof: "verified-source" });

    const err = r.lookup(toFunctionSelector("InsufficientBalance(uint256)"));
    expect(err[0]).toMatchObject({ kind: "error", proof: "verified-source" });
  });

  it("recordProven stores keccak-proven entries; stats counts by kind:proof", () => {
    const r = new Registry();
    expect(r.recordProven({ selector: "0xa9059cbb", kind: "function", signature: "transfer(address,uint256)" })).toBe(true);
    expect(r.lookup("0xA9059CBB")[0]!.proof).toBe("keccak-proven"); // lookup is case-insensitive
    expect(r.stats().selectors["function:keccak-proven"]).toBe(1);

    expect(r.recordProven({ selector: "0xa9059cbb", kind: "function", signature: "balanceOf(address)" })).toBe(false);
    expect(r.lookup("0xa9059cbb")).toHaveLength(1);
  });

  it("upgrades keccak-proven entries when verified source later confirms the same signature", () => {
    const r = new Registry();
    expect(r.recordProven({ selector: "0xa9059cbb", kind: "function", signature: "transfer(address,uint256)" })).toBe(true);

    r.recordVerifiedAbi(1, ADDR, VERIFIED_ABI as any);

    expect(r.lookup("0xa9059cbb")).toEqual([
      expect.objectContaining({
        selector: "0xa9059cbb",
        kind: "function",
        signature: "transfer(address,uint256)",
        proof: "verified-source",
        chain: 1,
        address: ADDR,
        abi_item: expect.objectContaining({ type: "function", name: "transfer" }),
      }),
    ]);
    expect(r.stats().selectors["function:verified-source"]).toBe(1);
    expect(r.stats().selectors["function:keccak-proven"]).toBeUndefined();
  });

  it("does not let later keccak-proven metadata downgrade a verified-source entry", () => {
    const r = new Registry();
    r.recordVerifiedAbi(1, ADDR, VERIFIED_ABI as any);

    expect(r.recordProven({
      selector: "0xa9059cbb",
      kind: "function",
      signature: "transfer(address,uint256)",
      abi_item: {
        type: "function",
        name: "transfer",
        stateMutability: "nonpayable",
        inputs: [
          { name: "to", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [],
      },
      chain: 8453,
      address: "0x00000000000000000000000000000000000000bb" as const,
    })).toBe(true);

    expect(r.lookup("0xa9059cbb")).toEqual([
      expect.objectContaining({
        proof: "verified-source",
        chain: 1,
        address: ADDR,
        abi_item: expect.objectContaining({
          type: "function",
          name: "transfer",
          outputs: [{ name: "", type: "bool" }],
        }),
      }),
    ]);
    expect(r.stats().selectors["function:verified-source"]).toBe(1);
    expect(r.stats().selectors["function:keccak-proven"]).toBeUndefined();
  });

  it("recordProven rejects contradictory ABI metadata", () => {
    const r = new Registry();
    expect(r.recordProven({
      selector: "0xa9059cbb",
      kind: "function",
      signature: "transfer(address,uint256)",
      abi_item: {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [
          { name: "spender", type: "address" },
          { name: "amount", type: "uint256" },
        ],
        outputs: [],
      },
    })).toBe(false);
    expect(r.lookup("0xa9059cbb")).toHaveLength(0);

    expect(r.recordProven({
      selector: "0xa9059cbb",
      kind: "function",
      signature: "transfer(address,uint256)",
      abi_item: VERIFIED_ABI[0],
    })).toBe(true);
    expect(r.lookup("0xa9059cbb")[0]).toMatchObject({
      signature: "transfer(address,uint256)",
      proof: "keccak-proven",
    });
  });

  it("normalizes selector writes and exports a deterministic commons order", () => {
    const r = new Registry();
    const later = "later(uint256)";
    const earlier = "earlier(address)";
    const laterSelector = toFunctionSelector(later);
    const earlierSelector = toFunctionSelector(earlier);
    r.recordProven({ selector: laterSelector.toUpperCase() as `0x${string}`, kind: "function", signature: later });
    r.recordProven({ selector: earlierSelector.toUpperCase() as `0x${string}`, kind: "function", signature: earlier });
    r.recordProven({ selector: laterSelector, kind: "function", signature: later });

    expect(r.lookup(laterSelector)).toHaveLength(1);
    expect(r.lookup(laterSelector.toUpperCase())).toMatchObject([{ selector: laterSelector, signature: later }]);

    const exported = r
      .exportSelectors()
      .filter((e) => e.signature === later || e.signature === earlier)
      .map((e) => `${e.kind}:${e.selector}:${e.signature}`);
    expect(exported).toEqual([
      `function:${earlierSelector}:${earlier}`,
      `function:${laterSelector}:${later}`,
    ].sort());
  });

  it("bytecode index: first write wins, round-trips provenance", () => {
    const r = new Registry();
    const hash = skeletonHash("0x6001");
    r.recordBytecode({ skeleton_hash: hash, abi: VERIFIED_ABI as any, source: "etherscan", confidence: "verified", names_synthetic: false, chain: 1, address: ADDR });
    r.recordBytecode({ skeleton_hash: hash, abi: [] as any, source: "4byte", confidence: "selector-only", names_synthetic: true, chain: 8453, address: ADDR });
    const hit = r.getBytecode(hash)!;
    expect(hit.source).toBe("etherscan");
    expect(hit.names_synthetic).toBe(false);
    expect(hit.abi).toHaveLength(3);
    expect(r.getBytecode(skeletonHash("0x6002"))).toBeUndefined();
  });

  it("normalizes bytecode hash writes before lookup", () => {
    const r = new Registry();
    const hash = skeletonHash("0x6001");
    r.recordBytecode({ skeleton_hash: hash.toUpperCase() as `0x${string}`, abi: VERIFIED_ABI as any, source: "etherscan", confidence: "verified", names_synthetic: false, chain: 1, address: ADDR });

    expect(r.getBytecode(hash)).toMatchObject({ skeleton_hash: hash, source: "etherscan" });
  });
});

describe("registry enrich (decompiled ABI name recovery)", () => {
  it("renames Unresolved_<selector> when the singleton registry holds a proven signature", () => {
    registry.recordProven({ selector: "0xa9059cbb", kind: "function", signature: "transfer(address,uint256)" });
    const decompiled = [
      { type: "function", name: "Unresolved_a9059cbb", stateMutability: "nonpayable", inputs: [{ name: "arg0", type: "address" }, { name: "arg1", type: "uint256" }], outputs: [] },
      { type: "function", name: "Unresolved_deadbeef", stateMutability: "view", inputs: [], outputs: [] },
      { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
    ];
    const { abi, recovered } = enrichDecompiledAbi(decompiled as any);
    expect(recovered).toBe(1);
    const names = abi.map((i: any) => i.name);
    expect(names).toContain("transfer");
    expect(names).toContain("Unresolved_deadbeef"); // unknown stays
    expect(names).toContain("balanceOf"); // already-named stays
  });

  it("does not guess when a selector is ambiguous at the same proof grade", () => {
    // Real 4-byte collision: two distinct signatures hash to 0x77dbd42e.
    registry.recordProven({ selector: "0x77dbd42e", kind: "function", signature: "f38491(uint256)" });
    registry.recordProven({ selector: "0x77dbd42e", kind: "function", signature: "f116643(uint256)" });
    const { abi, recovered } = enrichDecompiledAbi([
      { type: "function", name: "Unresolved_77dbd42e", stateMutability: "nonpayable", inputs: [{ name: "arg0", type: "uint256" }], outputs: [] },
    ] as any);
    expect(recovered).toBe(0);
    expect((abi[0] as any).name).toBe("Unresolved_77dbd42e");
  });
});
