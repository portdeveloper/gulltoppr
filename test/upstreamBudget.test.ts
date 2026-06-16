import { describe, expect, it } from "vitest";
import { FixedWindowBudget } from "../src/upstreamBudget.js";

describe("FixedWindowBudget", () => {
  it("allows only the configured number of attempts per window", () => {
    let now = 1_000;
    const budget = new FixedWindowBudget(2, 1_000, () => now);

    expect(budget.check()).toMatchObject({ ok: true, remaining: 1 });
    expect(budget.check()).toMatchObject({ ok: true, remaining: 0 });
    expect(budget.check()).toMatchObject({ ok: false, remaining: 0, resetSec: 1 });

    now = 2_001;
    expect(budget.check()).toMatchObject({ ok: true, remaining: 1 });
  });

  it("treats zero as unlimited", () => {
    const budget = new FixedWindowBudget(0, 1_000);
    expect(budget.check()).toEqual({ ok: true, limit: 0, remaining: 0, resetSec: 0 });
    expect(budget.check()).toEqual({ ok: true, limit: 0, remaining: 0, resetSec: 0 });
  });
});
