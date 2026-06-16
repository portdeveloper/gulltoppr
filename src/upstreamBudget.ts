export interface BudgetResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetSec: number;
}

/** Small fixed-window budget for shared upstream keys. Unlike the public per-IP
 * limiter, this protects one process's outbound calls to a specific upstream rung. */
export class FixedWindowBudget {
  private count = 0;
  private resetAt = 0;

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  check(): BudgetResult {
    const t = this.now();
    if (this.max <= 0) return { ok: true, limit: this.max, remaining: this.max, resetSec: 0 };
    if (this.resetAt <= t) {
      this.count = 0;
      this.resetAt = t + this.windowMs;
    }
    this.count++;
    const resetSec = Math.ceil((this.resetAt - t) / 1000);
    return {
      ok: this.count <= this.max,
      limit: this.max,
      remaining: Math.max(0, this.max - this.count),
      resetSec,
    };
  }
}
