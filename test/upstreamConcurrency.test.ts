import { describe, expect, it } from "vitest";
import { UpstreamConcurrency } from "../src/upstreamConcurrency.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("UpstreamConcurrency", () => {
  it("runs queued work after the active slot is released", async () => {
    const limiter = new UpstreamConcurrency(1);
    const order: string[] = [];

    const first = limiter.run("test", 100, async () => {
      order.push("first-start");
      await sleep(10);
      order.push("first-end");
      return 1;
    });
    const second = limiter.run("test", 100, async () => {
      order.push("second-start");
      return 2;
    });

    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(order).toEqual(["first-start", "first-end", "second-start"]);
  });

  it("times out queued work without starting it", async () => {
    const limiter = new UpstreamConcurrency(1);
    let secondStarted = false;

    const first = limiter.run("test", 100, async () => {
      await sleep(25);
      return 1;
    });
    const second = limiter.run("test", 5, async () => {
      secondStarted = true;
      return 2;
    });

    await expect(second).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
      details: { max_concurrency: 1 },
    });
    expect(secondStarted).toBe(false);
    await expect(first).resolves.toBe(1);
  });

  it("treats zero as unlimited", async () => {
    const limiter = new UpstreamConcurrency(0);
    let active = 0;
    let maxActive = 0;

    await Promise.all(
      [1, 2, 3].map((value) =>
        limiter.run("test", 0, async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await sleep(1);
          active -= 1;
          return value;
        }),
      ),
    );

    expect(maxActive).toBe(3);
  });
});
