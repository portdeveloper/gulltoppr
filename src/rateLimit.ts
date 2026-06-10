/**
 * Per-IP fixed-window rate limiting. The engine + MCP are public and lean on a
 * shared Etherscan key, public RPCs, and gulltoppr, so an unthrottled flood could
 * exhaust the key's budget or run up cost. This is a per-instance in-memory limiter
 * (fine for the single-machine deploys; back it with a shared store if we scale out).
 *
 * `RateLimiter` is transport-agnostic; the Hono middleware (engine) and the raw-http
 * MCP server both use it. Private 6PN IPs (fdaa:…) and a configured allowlist are
 * exempt so internal/service-to-service traffic isn't throttled.
 */
import type { Context, Next } from "hono";
import { ApiError } from "./errors.js";
import { config } from "./config.js";

export interface RateResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetSec: number;
}

export class RateLimiter {
  private buckets = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly allow: Set<string> = new Set(),
    private readonly maxKeys = 50_000,
  ) {}

  check(ip: string): RateResult {
    const now = Date.now();
    if (this.max <= 0 || this.allow.has(ip) || ip.startsWith("fdaa:")) {
      return { ok: true, limit: this.max, remaining: this.max, resetSec: 0 };
    }
    let b = this.buckets.get(ip);
    if (!b || b.resetAt <= now) {
      this.evictIfNeeded(now);
      b = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(ip, b);
    }
    b.count++;
    const resetSec = Math.ceil((b.resetAt - now) / 1000);
    return { ok: b.count <= this.max, limit: this.max, remaining: Math.max(0, this.max - b.count), resetSec };
  }

  private evictIfNeeded(now: number): void {
    if (this.buckets.size < this.maxKeys) return;
    for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k);
    if (this.buckets.size >= this.maxKeys) {
      const oldest = this.buckets.keys().next().value;
      if (oldest !== undefined) this.buckets.delete(oldest);
    }
  }
}

/** Best-effort client IP: Fly sets Fly-Client-IP; fall back to X-Forwarded-For. */
export function clientIpFromHeaders(get: (h: string) => string | undefined | null): string {
  return get("fly-client-ip") || get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

const engineLimiter = new RateLimiter(config.rateLimitMax, config.rateLimitWindowMs, config.rateLimitAllow);

/** Hono middleware for the engine. Exempts /health and / so probes/warmers aren't limited. */
export async function rateLimit(c: Context, next: Next): Promise<Response | void> {
  const path = c.req.path;
  if (path === "/health" || path === "/") return next();

  const ip = clientIpFromHeaders((h) => c.req.header(h));
  const r = engineLimiter.check(ip);
  c.header("RateLimit-Limit", String(r.limit));
  c.header("RateLimit-Remaining", String(r.remaining));
  c.header("RateLimit-Reset", String(r.resetSec));
  if (!r.ok) {
    c.header("Retry-After", String(r.resetSec));
    throw new ApiError("RATE_LIMITED", `Rate limit exceeded (${r.limit}/${config.rateLimitWindowMs / 1000}s). Retry in ${r.resetSec}s.`);
  }
  return next();
}
