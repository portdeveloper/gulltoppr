/**
 * Ladder rung 5 — selector-level fallback (SPEC §8). Last resort when even
 * heimdall fails (decompiler down, exotic bytecode): extract the function
 * selectors from the dispatcher and name them, REGISTRY FIRST.
 *
 * Naming order per selector:
 *   1. Our registry — proven entries only (`verified-source` harvested from
 *      verified code, or `keccak-proven`). Trustworthy by construction.
 *   2. 4byte.directory — oldest entry for the selector (junk is collision-mined
 *      *after* the legitimate name, so oldest-first dodges most poisoning).
 *      Still unproven — flagged as such in the notes.
 *   3. Neither → the function appears as `Unresolved_<selector>()`.
 *
 * The result is selector-level only: param types come from parsed signatures,
 * mutability is unknown (reported nonpayable), outputs unknown. Honest
 * provenance (`selector-only`, names_synthetic) is the whole point.
 */
import { parseAbiItem } from "viem";
import type { Abi, AbiFunction, Hex } from "viem";
import { registry } from "../registry/store.js";

const MAX_SELECTORS = 64; // dispatcher scans on weird bytecode can explode; cap
const MAX_4BYTE_LOOKUPS = 32;
const FOURBYTE_TIMEOUT_MS = 5000;

/**
 * Extract candidate function selectors from runtime bytecode by walking opcodes
 * (respecting PUSH data so we don't read constants as code) and collecting
 * PUSH4 operands — the dispatcher's `PUSH4 <selector> EQ` comparisons.
 */
export function extractSelectors(code: Hex): Hex[] {
  const hex = code.toLowerCase().replace(/^0x/, "");
  const out = new Set<string>();
  for (let i = 0; i + 2 <= hex.length; ) {
    const op = parseInt(hex.slice(i, i + 2), 16);
    i += 2;
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f; // PUSH1..PUSH32 → 1..32 data bytes
      if (op === 0x63 && i + 8 <= hex.length) {
        const sel = hex.slice(i, i + 8);
        if (sel !== "ffffffff" && sel !== "00000000") out.add("0x" + sel);
      }
      i += n * 2;
    }
  }
  return [...out].slice(0, MAX_SELECTORS) as Hex[];
}

/** Best proven signature for a selector from our registry, or null. */
function fromRegistry(selector: Hex): string | null {
  const fns = registry.lookup(selector).filter((e) => e.kind === "function");
  for (const proof of ["verified-source", "keccak-proven"] as const) {
    const sigs = new Set(fns.filter((e) => e.proof === proof).map((e) => e.signature));
    if (sigs.size === 1) return [...sigs][0]!;
    if (sigs.size > 1) return null; // ambiguous — don't guess
  }
  return null;
}

/** Oldest 4byte.directory entry for a selector, or null. */
async function from4byteDir(selector: Hex): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}&ordering=created_at`,
      { signal: AbortSignal.timeout(FOURBYTE_TIMEOUT_MS), headers: { accept: "application/json" } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: { text_signature?: string }[] };
    const sig = data.results?.[0]?.text_signature;
    return typeof sig === "string" && sig.length <= 512 ? sig : null;
  } catch {
    return null;
  }
}

function toAbiFunction(signature: string): AbiFunction | null {
  try {
    const parsed = parseAbiItem(`function ${signature}`) as AbiFunction;
    return { ...parsed, stateMutability: "nonpayable", outputs: [] };
  } catch {
    return null;
  }
}

export interface FourByteResult {
  abi: Abi;
  /** Honest accounting for the provenance notes. */
  counts: { registry: number; fourbyte: number; unresolved: number };
}

export async function fromFourByte(code: Hex | undefined): Promise<FourByteResult | null> {
  if (!code || code === "0x") return null;
  const selectors = extractSelectors(code);
  if (selectors.length === 0) return null;

  const counts = { registry: 0, fourbyte: 0, unresolved: 0 };
  const items: AbiFunction[] = [];
  let fourbyteBudget = MAX_4BYTE_LOOKUPS;

  for (const selector of selectors) {
    let fn: AbiFunction | null = null;

    const proven = fromRegistry(selector);
    if (proven) {
      fn = toAbiFunction(proven);
      if (fn) counts.registry++;
    }
    if (!fn && fourbyteBudget > 0) {
      fourbyteBudget--;
      const sig = await from4byteDir(selector);
      if (sig) {
        fn = toAbiFunction(sig);
        if (fn) counts.fourbyte++;
      }
    }
    if (!fn) {
      counts.unresolved++;
      fn = {
        type: "function",
        name: `Unresolved_${selector.slice(2)}`,
        stateMutability: "nonpayable",
        inputs: [],
        outputs: [],
      };
    }
    items.push(fn);
  }

  return { abi: items as Abi, counts };
}
