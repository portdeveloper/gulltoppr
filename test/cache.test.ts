import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { JsonCache } from "../src/cache.js";

describe("JsonCache (in-memory store)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("stores and retrieves typed values", () => {
    const c = new JsonCache<{ n: number }>("t1:");
    c.set("a", { n: 42 }, 60);
    expect(c.get("a")).toEqual({ n: 42 });
  });

  it("returns undefined for missing keys", () => {
    expect(new JsonCache<number>("t2:").get("nope")).toBeUndefined();
  });

  it("expires entries after the TTL", () => {
    const c = new JsonCache<string>("t3:");
    c.set("k", "v", 10); // 10s
    expect(c.get("k")).toBe("v");
    vi.setSystemTime(11_000);
    expect(c.get("k")).toBeUndefined();
  });

  it("namespaces by prefix (no cross-talk between caches)", () => {
    const a = new JsonCache<string>("ns-a:");
    const b = new JsonCache<string>("ns-b:");
    a.set("same", "A", 60);
    b.set("same", "B", 60);
    expect(a.get("same")).toBe("A");
    expect(b.get("same")).toBe("B");
  });
});
