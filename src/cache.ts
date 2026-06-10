/**
 * Result cache for the engine. Without it, every request re-runs the whole ladder
 * (Etherscan → Sourcify → proxy → heimdall → 4byte) — and since all four faces call
 * the same verbs, one warm entry serves them all.
 *
 * Two backends behind one sync interface:
 *  - SqliteStore (node:sqlite on a Fly volume) — PERSISTENT across redeploys and
 *    idle-stops; used when CACHE_DB_PATH points at a writable location. Decompiled
 *    ABIs are deterministic per bytecode, so persisting them is a real win.
 *  - MemoryStore — per-instance LRU+TTL fallback when no DB path / sqlite is
 *    unavailable (e.g. local dev without --experimental-sqlite).
 *
 * node:sqlite needs Node's --experimental-sqlite flag; we require() it lazily so a
 * runtime without the flag simply falls back to memory instead of crashing.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface Store {
  get(key: string): string | undefined;
  set(key: string, value: string, ttlSeconds: number): void;
}

class MemoryStore implements Store {
  private m = new Map<string, { v: string; expires: number }>();
  constructor(private readonly max = 5000) {}
  get(key: string): string | undefined {
    const e = this.m.get(key);
    if (!e) return undefined;
    if (e.expires <= Date.now()) {
      this.m.delete(key);
      return undefined;
    }
    this.m.delete(key);
    this.m.set(key, e); // LRU refresh
    return e.v;
  }
  set(key: string, value: string, ttlSeconds: number): void {
    if (this.m.size >= this.max) {
      const oldest = this.m.keys().next().value;
      if (oldest !== undefined) this.m.delete(oldest);
    }
    this.m.set(key, { v: value, expires: Date.now() + ttlSeconds * 1000 });
  }
}

class SqliteStore implements Store {
  private db: any;
  private getStmt: any;
  private setStmt: any;
  private delStmt: any;
  constructor(path: string) {
    const { DatabaseSync } = require("node:sqlite");
    this.db = new DatabaseSync(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, expires INTEGER NOT NULL)");
    this.getStmt = this.db.prepare("SELECT v, expires FROM kv WHERE k = ?");
    this.setStmt = this.db.prepare("INSERT INTO kv (k, v, expires) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, expires = excluded.expires");
    this.delStmt = this.db.prepare("DELETE FROM kv WHERE k = ?");
  }
  get(key: string): string | undefined {
    const row = this.getStmt.get(key) as { v: string; expires: number } | undefined;
    if (!row) return undefined;
    if (row.expires <= Date.now()) {
      this.delStmt.run(key);
      return undefined;
    }
    return row.v;
  }
  set(key: string, value: string, ttlSeconds: number): void {
    this.setStmt.run(key, value, Date.now() + ttlSeconds * 1000);
  }
  handle(): any {
    return this.db;
  }
}

/** The shared DatabaseSync handle, so other modules (the registry) can add their
 * own tables to the same DB file without a second connection (avoids locking). */
let sharedDb: any = null;

function makeStore(): Store {
  const path = process.env.CACHE_DB_PATH;
  if (path) {
    try {
      const s = new SqliteStore(path);
      sharedDb = s.handle();
      console.log(`[cache] persistent SQLite store at ${path}`);
      return s;
    } catch (e) {
      console.error(`[cache] SQLite unavailable (${(e as Error).message}); using in-memory cache`);
    }
  }
  return new MemoryStore();
}

const store = makeStore();

/** The shared node:sqlite DatabaseSync, or null when running on the memory fallback. */
export function getDb(): any {
  return sharedDb;
}

/** Typed, namespaced view over the shared store. Values are JSON-serialized. */
export class JsonCache<T> {
  constructor(private readonly prefix: string) {}
  get(key: string): T | undefined {
    const s = store.get(this.prefix + key);
    if (s === undefined) return undefined;
    try {
      return JSON.parse(s) as T;
    } catch {
      return undefined;
    }
  }
  set(key: string, value: T, ttlSeconds: number): void {
    store.set(this.prefix + key, JSON.stringify(value), ttlSeconds);
  }
}
