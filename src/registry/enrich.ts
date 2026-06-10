/**
 * Registry enrichment of decompiled ABIs. heimdall names functions it can't
 * resolve `Unresolved_<selector>`; when the registry holds a proven signature
 * for that selector (verified-source or keccak-proven), substitute the real
 * name + input types. Outputs/mutability stay heimdall's unless the registry
 * holds a full verified ABI item (then it's strictly better evidence).
 *
 * Names become non-synthetic per-function; the ABI-level provenance stays
 * `decompiled` — enrichment proves signatures, not semantics.
 */
import { parseAbiItem } from "viem";
import type { Abi, AbiFunction } from "viem";
import { registry, type SelectorEntry } from "./store.js";

const UNRESOLVED = /^unresolved_(?:0x)?([0-9a-f]{8})$/i;

/** Pick the best entry for a selector: verified-source beats keccak-proven;
 * ambiguous (multiple distinct signatures at the same grade) → null. */
function bestEntry(entries: SelectorEntry[]): SelectorEntry | null {
  const fns = entries.filter((e) => e.kind === "function");
  for (const proof of ["verified-source", "keccak-proven"] as const) {
    const graded = fns.filter((e) => e.proof === proof);
    const signatures = new Set(graded.map((e) => e.signature));
    if (signatures.size === 1) return graded[0]!;
    if (signatures.size > 1) return null; // collision — don't guess
  }
  return null;
}

export interface EnrichResult {
  abi: Abi;
  /** Number of Unresolved_ functions renamed from proven registry entries. */
  recovered: number;
}

export function enrichDecompiledAbi(abi: Abi): EnrichResult {
  let recovered = 0;
  const out = abi.map((item) => {
    if (item.type !== "function") return item;
    const m = UNRESOLVED.exec(item.name);
    if (!m) return item;
    const selector = ("0x" + m[1]!.toLowerCase()) as `0x${string}`;
    const entry = bestEntry(registry.lookup(selector));
    if (!entry) return item;

    if (entry.proof === "verified-source" && entry.abi_item) {
      return entry.abi_item as AbiFunction; // full item incl. outputs/mutability
    }
    try {
      const parsed = parseAbiItem(`function ${entry.signature}`) as AbiFunction;
      return { ...item, name: parsed.name, inputs: parsed.inputs } as AbiFunction;
    } catch {
      return item;
    }
  });
  // Count after mapping so a thrown parse doesn't inflate the number.
  for (let i = 0; i < abi.length; i++) if (out[i] !== abi[i]) recovered++;
  return { abi: out as Abi, recovered };
}
