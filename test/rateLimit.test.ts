import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RateLimiter, clientIpFromHeaders } from "../src/rateLimit.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => vi.useRealTimers());

  it("allows up to the limit then blocks", () => {
    const rl = new RateLimiter(3, 60_000);
    expect(rl.check("1.1.1.1").ok).toBe(true);
    expect(rl.check("1.1.1.1").ok).toBe(true);
    expect(rl.check("1.1.1.1").ok).toBe(true);
    expect(rl.check("1.1.1.1").ok).toBe(false);
  });

  it("tracks each IP independently", () => {
    const rl = new RateLimiter(1, 60_000);
    expect(rl.check("a").ok).toBe(true);
    expect(rl.check("a").ok).toBe(false);
    expect(rl.check("b").ok).toBe(true);
  });

  it("resets after the window elapses", () => {
    const rl = new RateLimiter(1, 1_000);
    expect(rl.check("x").ok).toBe(true);
    expect(rl.check("x").ok).toBe(false);
    vi.setSystemTime(1_001);
    expect(rl.check("x").ok).toBe(true);
  });

  it("exempts allowlisted and private 6PN IPs", () => {
    const rl = new RateLimiter(1, 60_000, new Set(["9.9.9.9"]));
    expect(rl.check("9.9.9.9").ok).toBe(true);
    expect(rl.check("9.9.9.9").ok).toBe(true);
    expect(rl.check("fdaa:0:1::2").ok).toBe(true);
    expect(rl.check("fdaa:0:1::2").ok).toBe(true);
  });

  it("treats max<=0 as disabled", () => {
    const rl = new RateLimiter(0, 60_000);
    for (let i = 0; i < 10; i++) expect(rl.check("z").ok).toBe(true);
  });

  it("reports remaining and resetSec", () => {
    const rl = new RateLimiter(2, 60_000);
    expect(rl.check("p")).toMatchObject({ remaining: 1, resetSec: 60 });
    expect(rl.check("p").remaining).toBe(0);
  });
});

describe("clientIpFromHeaders", () => {
  it("prefers fly-client-ip", () => {
    expect(clientIpFromHeaders((h) => ({ "fly-client-ip": "5.5.5.5", "x-forwarded-for": "1.1.1.1" })[h])).toBe("5.5.5.5");
  });
  it("falls back to the first x-forwarded-for", () => {
    expect(clientIpFromHeaders((h) => ({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" })[h])).toBe("1.1.1.1");
  });
  it("defaults to 'unknown'", () => {
    expect(clientIpFromHeaders(() => undefined)).toBe("unknown");
  });
});
