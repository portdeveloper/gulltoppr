/**
 * Ladder rung 3 — proxy detection (SPEC §8). Reads the standard EIP-1967 slots and
 * the minimal-proxy (EIP-1167) bytecode pattern to find an implementation address.
 * The orchestrator then recurses the ladder on that implementation. For diamonds
 * (EIP-2535), the standard loupe returns facet addresses plus selectors, so the
 * orchestrator builds a merged ABI from the active facet functions.
 */
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import type { ProxyPattern } from "../types.js";
import { trackBestEffortMetric } from "../metrics.js";

// EIP-1967 storage slots.
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as Hex;
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as Hex;

export interface DiamondFacet {
  address: Address;
  selectors: Hex[];
}

export type ProxyDetection = {
  pattern: Exclude<ProxyPattern, "diamond">;
  implementation: Address;
  beacon?: Address;
} | {
  pattern: "diamond";
  facets: DiamondFacet[];
};

/** Last 20 bytes of a 32-byte slot → checksummed address, or null if zero. */
function slotToAddress(slot: Hex | undefined): Address | null {
  if (!slot || slot.length < 42) return null;
  const addr = "0x" + slot.slice(-40);
  if (/^0x0{40}$/i.test(addr)) return null;
  return getAddress(addr);
}

const BEACON_ABI = [
  { type: "function", name: "implementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const DIAMOND_LOUPE_ABI = [
  {
    type: "function",
    name: "facets",
    stateMutability: "view",
    inputs: [],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "facetAddress", type: "address" },
          { name: "functionSelectors", type: "bytes4[]" },
        ],
      },
    ],
  },
] as const;

function validSelector(selector: Hex): selector is `0x${string}` {
  return /^0x[0-9a-fA-F]{8}$/.test(selector);
}

async function detectDiamond(client: PublicClient, address: Address): Promise<ProxyDetection | null> {
  const facets = await trackBestEffortMetric(
    "rpc.readContract.proxy.diamond_facets",
    () => client.readContract({
      address,
      abi: DIAMOND_LOUPE_ABI,
      functionName: "facets",
    }),
    () => undefined,
  );
  if (!facets) return null;

  const normalized = facets
    .map((facet) => ({
      address: getAddress(facet.facetAddress),
      selectors: [...facet.functionSelectors].filter(validSelector).map((selector) => selector.toLowerCase() as Hex),
    }))
    .filter((facet) => !/^0x0{40}$/i.test(facet.address) && facet.selectors.length > 0);
  if (!normalized.length) return null;
  return { pattern: "diamond", facets: normalized };
}

export async function detectProxy(client: PublicClient, address: Address): Promise<ProxyDetection | null> {
  // 1) EIP-1967 implementation slot (covers transparent + UUPS).
  const implSlot = await trackBestEffortMetric(
    "rpc.getStorageAt.proxy.implementation_slot",
    () => client.getStorageAt({ address, slot: IMPL_SLOT }),
    () => undefined,
    "failure",
  );
  const impl = slotToAddress(implSlot);
  if (impl) {
    const adminSlot = await trackBestEffortMetric(
      "rpc.getStorageAt.proxy.admin_slot",
      () => client.getStorageAt({ address, slot: ADMIN_SLOT }),
      () => undefined,
      "failure",
    );
    const pattern: ProxyPattern = slotToAddress(adminSlot) ? "transparent" : "eip1967";
    return { pattern, implementation: impl };
  }

  // 2) EIP-1967 beacon slot → call implementation() on the beacon.
  const beaconSlot = await trackBestEffortMetric(
    "rpc.getStorageAt.proxy.beacon_slot",
    () => client.getStorageAt({ address, slot: BEACON_SLOT }),
    () => undefined,
    "failure",
  );
  const beacon = slotToAddress(beaconSlot);
  if (beacon) {
    const beaconImpl = await trackBestEffortMetric(
      "rpc.readContract.proxy.beacon_implementation",
      () => client.readContract({
        address: beacon,
        abi: BEACON_ABI,
        functionName: "implementation",
      }),
      () => undefined,
      "failure",
    ) as Address | undefined;
    if (beaconImpl) return { pattern: "beacon", implementation: getAddress(beaconImpl), beacon };
  }

  // 3) Minimal proxy (EIP-1167): bytecode embeds the target address.
  const code = await trackBestEffortMetric(
    "rpc.getCode.proxy.minimal",
    () => client.getCode({ address }),
    () => undefined,
    "failure",
  );
  if (code) {
    const m = /^0x363d3d373d3d3d363d73([0-9a-fA-F]{40})5af43d82803e903d91602b57fd5bf3$/.exec(code);
    if (m && m[1]) return { pattern: "minimal-1167", implementation: getAddress("0x" + m[1]) };
  }

  // 4) EIP-2535 diamond: the loupe exposes active facets and selectors.
  const diamond = await detectDiamond(client, address);
  if (diamond) return diamond;

  return null;
}
