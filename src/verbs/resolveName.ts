/**
 * resolve_name (SPEC §3) — ENS ⇄ address, both directions. ENS resolves on mainnet.
 *
 * TODO: basenames (*.base.eth) resolve via Base's L2 resolver, not mainnet ENS —
 * route those to the Base client / UniversalResolver. For now they fall through to
 * mainnet (which won't resolve them) and return null.
 */
import { getAddress, isAddress, type Address } from "viem";
import { normalize } from "viem/ens";
import { getEnsClient } from "../clients.js";

export interface ResolveNameResult {
  address?: Address;
  name?: string;
}

export async function resolveName(input: string): Promise<ResolveNameResult> {
  const client = getEnsClient();

  // Reverse: address → primary name.
  if (isAddress(input)) {
    const address = getAddress(input);
    const name = await client.getEnsName({ address }).catch(() => null);
    return { address, ...(name ? { name } : {}) };
  }

  // Forward: name → address.
  const address = await client.getEnsAddress({ name: normalize(input) }).catch(() => null);
  return { name: input, ...(address ? { address } : {}) };
}
