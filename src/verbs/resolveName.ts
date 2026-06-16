/**
 * resolve_name (SPEC §3) — ENS/Basenames ⇄ address, both directions.
 *
 * Resolution starts from mainnet ENS. For non-mainnet chain inputs, pass the
 * ENSIP-9/11 coin type so viem's Universal Resolver path verifies the chain-
 * specific address/primary-name relationship (e.g. Base/Basenames).
 */
import { getAddress, isAddress, toCoinType, type Address } from "viem";
import { normalize } from "viem/ens";
import { getEnsClient } from "../clients.js";
import { resolveChain } from "../chains.js";
import { trackMetric } from "../metrics.js";
import { ApiError } from "../errors.js";

export interface ResolveNameResult {
  address?: Address;
  name?: string;
}

function coinTypeForChain(chainInput: number | string): bigint | undefined {
  if (typeof chainInput === "number" || /^\d+$/.test(chainInput)) {
    const id = Number(chainInput);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new ApiError("UNKNOWN_CHAIN", `Invalid chain id ${chainInput}.`);
    }
    return id === 1 ? undefined : toCoinType(id);
  }
  const resolved = resolveChain(chainInput);
  return resolved.id === 1 ? undefined : toCoinType(resolved.id);
}

function normalizeName(input: string): string {
  try {
    return normalize(input);
  } catch {
    throw new ApiError("INVALID_ARGS", `Not a valid ENS/Basename: "${input}"`);
  }
}

export async function resolveName(chainInput: number | string, input: string): Promise<ResolveNameResult> {
  const client = getEnsClient();
  const coinType = coinTypeForChain(chainInput);

  // Reverse: address → primary name.
  if (isAddress(input)) {
    const address = getAddress(input);
    const name = await trackMetric("rpc.getEnsName.resolve_name", () =>
      client.getEnsName({ address, ...(coinType ? { coinType } : {}) }),
    ).catch(() => null);
    return { address, ...(name ? { name } : {}) };
  }

  // Forward: name → address.
  const normalized = normalizeName(input);
  const address = await trackMetric("rpc.getEnsAddress.resolve_name", () =>
    client.getEnsAddress({ name: normalized, ...(coinType ? { coinType } : {}) }),
  ).catch(() => null);
  return { name: input, ...(address ? { address } : {}) };
}
