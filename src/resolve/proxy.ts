/**
 * Ladder rung 3 — proxy detection (SPEC §8). Reads the standard EIP-1967 slots and
 * the minimal-proxy (EIP-1167) bytecode pattern to find an implementation address.
 * The orchestrator then recurses the ladder on that implementation. Diamonds
 * (EIP-2535) are not yet handled (TODO).
 */
import { getAddress, type Address, type Hex, type PublicClient } from "viem";
import type { ProxyPattern } from "../types.js";

// EIP-1967 storage slots.
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as Hex;
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as Hex;
const ADMIN_SLOT = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103" as Hex;

export interface ProxyDetection {
  pattern: ProxyPattern;
  implementation: Address;
  beacon?: Address;
}

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

export async function detectProxy(client: PublicClient, address: Address): Promise<ProxyDetection | null> {
  // 1) EIP-1967 implementation slot (covers transparent + UUPS).
  const implSlot = await client.getStorageAt({ address, slot: IMPL_SLOT }).catch(() => undefined);
  const impl = slotToAddress(implSlot);
  if (impl) {
    const adminSlot = await client.getStorageAt({ address, slot: ADMIN_SLOT }).catch(() => undefined);
    const pattern: ProxyPattern = slotToAddress(adminSlot) ? "transparent" : "eip1967";
    return { pattern, implementation: impl };
  }

  // 2) EIP-1967 beacon slot → call implementation() on the beacon.
  const beaconSlot = await client.getStorageAt({ address, slot: BEACON_SLOT }).catch(() => undefined);
  const beacon = slotToAddress(beaconSlot);
  if (beacon) {
    try {
      const beaconImpl = (await client.readContract({
        address: beacon,
        abi: BEACON_ABI,
        functionName: "implementation",
      })) as Address;
      if (beaconImpl) return { pattern: "beacon", implementation: getAddress(beaconImpl), beacon };
    } catch {
      /* beacon without implementation() — fall through */
    }
  }

  // 3) Minimal proxy (EIP-1167): bytecode embeds the target address.
  const code = await client.getCode({ address }).catch(() => undefined);
  if (code) {
    const m = /^0x363d3d373d3d3d363d73([0-9a-fA-F]{40})5af43d82803e903d91602b57fd5bf3$/.exec(code);
    if (m && m[1]) return { pattern: "minimal-1167", implementation: getAddress("0x" + m[1]) };
  }

  return null;
}
