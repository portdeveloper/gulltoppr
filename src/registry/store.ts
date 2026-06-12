/**
 * The registry store — the engine-side seed of the ABI/selector commons.
 *
 * Two tables, both fed as a *byproduct* of resolution (no extra upstream calls):
 *  - registry_selectors: selector → canonical signature, graded by proof:
 *      'verified-source' — extracted from a source-verified ABI (ground truth).
 *      'keccak-proven'   — LLM-proposed, accepted only when keccak256(sig)
 *                          reproduces the selector AND param types match the
 *                          decompiler's recovered types. Name+types proven;
 *                          semantics still inferred.
 *    Events use the full 32-byte topic0 (collision-free); functions/errors the
 *    4-byte selector. Only OUR pipeline writes — open submissions would
 *    recreate 4byte's collision-poisoning problem.
 *  - registry_bytecode: skeleton-hash → a previous resolution, so byte-identical
 *    clones (modulo metadata) resolve without re-running the ladder.
 *
 * Shares the cache's SQLite connection (one file, one handle); falls back to
 * in-memory maps when sqlite is unavailable (local dev / unit tests).
 */
import { keccak256, stringToBytes, toEventSelector, toEventSignature, toFunctionSelector, toFunctionSignature } from "viem";
import type { Abi, AbiEvent, AbiFunction, Address, Hex } from "viem";
import { getDb } from "../cache.js";
import type { Provenance } from "../types.js";

export type SelectorKind = "function" | "event" | "error";
export type Proof = "verified-source" | "keccak-proven";

export interface SelectorEntry {
  selector: Hex;
  kind: SelectorKind;
  signature: string;
  proof: Proof;
  /** Full ABI item when we have one (outputs/mutability may be inferred even when the signature is proven). */
  abi_item?: unknown;
  chain?: number;
  address?: Address;
}

export interface BytecodeEntry {
  skeleton_hash: Hex;
  abi: Abi;
  source: Provenance["source"];
  confidence: Provenance["confidence"];
  names_synthetic: boolean;
  chain: number;
  address: Address;
}

interface Backend {
  insertSelector(e: SelectorEntry): void;
  lookupSelector(selector: string): SelectorEntry[];
  exportSelectors(): SelectorEntry[];
  getBytecode(hash: string): BytecodeEntry | undefined;
  setBytecode(e: BytecodeEntry): void;
  stats(): { selectors: Record<string, number>; bytecodes: number };
}

class SqliteBackend implements Backend {
  private ins: any;
  private sel: any;
  private bcGet: any;
  private bcSet: any;
  private db: any;
  constructor(db: any) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS registry_selectors (
        selector TEXT NOT NULL,
        kind TEXT NOT NULL,
        signature TEXT NOT NULL,
        proof TEXT NOT NULL,
        abi_json TEXT,
        chain INTEGER,
        address TEXT,
        first_seen INTEGER NOT NULL,
        PRIMARY KEY (selector, kind, signature)
      );
      CREATE TABLE IF NOT EXISTS registry_bytecode (
        skeleton_hash TEXT PRIMARY KEY,
        abi_json TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence TEXT NOT NULL,
        names_synthetic INTEGER NOT NULL,
        chain INTEGER NOT NULL,
        address TEXT NOT NULL,
        first_seen INTEGER NOT NULL
      );
    `);
    this.ins = db.prepare(
      "INSERT OR IGNORE INTO registry_selectors (selector, kind, signature, proof, abi_json, chain, address, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.sel = db.prepare("SELECT * FROM registry_selectors WHERE selector = ?");
    this.bcGet = db.prepare("SELECT * FROM registry_bytecode WHERE skeleton_hash = ?");
    this.bcSet = db.prepare(
      "INSERT OR IGNORE INTO registry_bytecode (skeleton_hash, abi_json, source, confidence, names_synthetic, chain, address, first_seen) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
  }
  insertSelector(e: SelectorEntry): void {
    this.ins.run(e.selector, e.kind, e.signature, e.proof, e.abi_item ? JSON.stringify(e.abi_item) : null, e.chain ?? null, e.address ?? null, Date.now());
  }
  private rowToEntry(r: any): SelectorEntry {
    return {
      selector: r.selector,
      kind: r.kind,
      signature: r.signature,
      proof: r.proof,
      ...(r.abi_json ? { abi_item: JSON.parse(r.abi_json) } : {}),
      ...(r.chain != null ? { chain: Number(r.chain) } : {}),
      ...(r.address ? { address: r.address } : {}),
    };
  }
  lookupSelector(selector: string): SelectorEntry[] {
    return (this.sel.all(selector) as any[]).map((r) => this.rowToEntry(r));
  }
  exportSelectors(): SelectorEntry[] {
    const rows = this.db.prepare("SELECT * FROM registry_selectors ORDER BY kind, selector, signature").all() as any[];
    return rows.map((r) => this.rowToEntry(r));
  }
  getBytecode(hash: string): BytecodeEntry | undefined {
    const r = this.bcGet.get(hash) as any;
    if (!r) return undefined;
    return {
      skeleton_hash: r.skeleton_hash,
      abi: JSON.parse(r.abi_json),
      source: r.source,
      confidence: r.confidence,
      names_synthetic: !!Number(r.names_synthetic),
      chain: Number(r.chain),
      address: r.address,
    };
  }
  setBytecode(e: BytecodeEntry): void {
    this.bcSet.run(e.skeleton_hash, JSON.stringify(e.abi), e.source, e.confidence, e.names_synthetic ? 1 : 0, e.chain, e.address, Date.now());
  }
  stats(): { selectors: Record<string, number>; bytecodes: number } {
    const selectors: Record<string, number> = {};
    for (const r of this.db.prepare("SELECT kind, proof, COUNT(*) AS n FROM registry_selectors GROUP BY kind, proof").all() as any[]) {
      selectors[`${r.kind}:${r.proof}`] = Number(r.n);
    }
    const bc = this.db.prepare("SELECT COUNT(*) AS n FROM registry_bytecode").get() as any;
    return { selectors, bytecodes: Number(bc?.n ?? 0) };
  }
}

class MemoryBackend implements Backend {
  private selectors = new Map<string, SelectorEntry[]>();
  private bytecodes = new Map<string, BytecodeEntry>();
  insertSelector(e: SelectorEntry): void {
    const list = this.selectors.get(e.selector) ?? [];
    if (!list.some((x) => x.kind === e.kind && x.signature === e.signature)) list.push(e);
    this.selectors.set(e.selector, list);
  }
  lookupSelector(selector: string): SelectorEntry[] {
    return this.selectors.get(selector) ?? [];
  }
  exportSelectors(): SelectorEntry[] {
    return [...this.selectors.values()]
      .flat()
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.selector.localeCompare(b.selector) || a.signature.localeCompare(b.signature));
  }
  getBytecode(hash: string): BytecodeEntry | undefined {
    return this.bytecodes.get(hash);
  }
  setBytecode(e: BytecodeEntry): void {
    if (!this.bytecodes.has(e.skeleton_hash)) this.bytecodes.set(e.skeleton_hash, e);
  }
  stats(): { selectors: Record<string, number>; bytecodes: number } {
    const selectors: Record<string, number> = {};
    for (const list of this.selectors.values()) {
      for (const e of list) {
        const k = `${e.kind}:${e.proof}`;
        selectors[k] = (selectors[k] ?? 0) + 1;
      }
    }
    return { selectors, bytecodes: this.bytecodes.size };
  }
}

function makeBackend(): Backend {
  const db = getDb();
  if (db) {
    try {
      return new SqliteBackend(db);
    } catch (e) {
      console.error(`[registry] sqlite backend failed (${(e as Error).message}); using memory`);
    }
  }
  return new MemoryBackend();
}

/** Canonical error signature + 4-byte selector (viem has no toErrorSelector). */
function errorSelector(item: { name: string; inputs?: readonly unknown[] }): { signature: string; selector: Hex } {
  const signature = toFunctionSignature({ ...(item as object), type: "function", outputs: [], stateMutability: "nonpayable" } as unknown as AbiFunction);
  return { signature, selector: keccak256(stringToBytes(signature)).slice(0, 10) as Hex };
}

export class Registry {
  private backend: Backend;
  constructor(backend?: Backend) {
    this.backend = backend ?? makeBackend();
  }

  /** Harvest ground-truth selector→signature pairs from a source-verified ABI.
   * Call ONLY for resolutions with non-synthetic names (etherscan / sourcify). */
  recordVerifiedAbi(chain: number, address: Address, abi: Abi): void {
    for (const item of abi) {
      try {
        if (item.type === "function") {
          const fn = item as AbiFunction;
          this.backend.insertSelector({
            selector: toFunctionSelector(fn),
            kind: "function",
            signature: toFunctionSignature(fn),
            proof: "verified-source",
            abi_item: fn,
            chain,
            address,
          });
        } else if (item.type === "event") {
          const ev = item as AbiEvent;
          this.backend.insertSelector({
            selector: toEventSelector(ev),
            kind: "event",
            signature: toEventSignature(ev),
            proof: "verified-source",
            abi_item: ev,
            chain,
            address,
          });
        } else if (item.type === "error") {
          const { signature, selector } = errorSelector(item);
          this.backend.insertSelector({ selector, kind: "error", signature, proof: "verified-source", abi_item: item, chain, address });
        }
      } catch (e) {
        console.error(`[registry] recordVerifiedAbi item failed: ${(e as Error).message}`);
      }
    }
  }

  /** Record an LLM-proposed signature that passed keccak + type verification. */
  recordProven(entry: Omit<SelectorEntry, "proof">): void {
    this.backend.insertSelector({ ...entry, proof: "keccak-proven" });
  }

  lookup(selector: string): SelectorEntry[] {
    return this.backend.lookupSelector(selector.toLowerCase());
  }

  getBytecode(hash: Hex): BytecodeEntry | undefined {
    return this.backend.getBytecode(hash);
  }

  recordBytecode(entry: BytecodeEntry): void {
    try {
      this.backend.setBytecode(entry);
    } catch (e) {
      console.error(`[registry] recordBytecode failed: ${(e as Error).message}`);
    }
  }

  stats(): { selectors: Record<string, number>; bytecodes: number } {
    return this.backend.stats();
  }

  /** Full deterministic dump of the selector commons (for the CC0 export). */
  exportSelectors(): SelectorEntry[] {
    return this.backend.exportSelectors();
  }
}

/** Singleton used by the ladder and the /lookup route. */
export const registry = new Registry();
