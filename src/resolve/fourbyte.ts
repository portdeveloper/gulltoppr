/**
 * Ladder rung 5 — 4byte / selector DB (SPEC §8). Last resort: per-function only, no
 * full ABI. In practice rung 4 (heimdall) yields an ABI for any contract with
 * bytecode, so this rarely fires.
 *
 * TODO: implement properly — extract selectors from the bytecode (PUSH4 scan) and
 * resolve each against https://www.4byte.directory, assembling a partial ABI tagged
 * `selector-only`. Stubbed to null for now so the ladder ends in ABI_NOT_FOUND
 * rather than a half-built result.
 */
import type { Abi, Address } from "viem";

export async function fromFourByte(_address: Address, _rpcUrl: string): Promise<Abi | null> {
  return null;
}
