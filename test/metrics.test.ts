import { beforeEach, describe, expect, it } from "vitest";
import { metricsSnapshot, recordMetric, resetMetricsForTests, trackBestEffortMetric, trackMetric } from "../src/metrics.js";

describe("runtime metrics", () => {
  beforeEach(() => resetMetricsForTests());

  it("tracks success, miss, failure, latency, and failure rate", async () => {
    recordMetric("rung.etherscan", "success", 10);
    recordMetric("rung.etherscan", "miss", 20);
    recordMetric("rung.etherscan", "failure", 30, new Error("upstream unavailable"));

    const bucket = metricsSnapshot().metrics["rung.etherscan"];
    expect(bucket).toMatchObject({
      attempts: 3,
      successes: 1,
      misses: 1,
      failures: 1,
      total_latency_ms: 60,
      avg_latency_ms: 20,
      max_latency_ms: 30,
      failure_rate: 1 / 3,
      last_error: "upstream unavailable",
    });
  });

  it("classifies tracked null results as misses and rethrows failures", async () => {
    await expect(trackMetric("rung.sourcify", async () => null)).resolves.toBeNull();
    await expect(trackMetric("rung.heimdall", async () => {
      throw new Error("deadline");
    })).rejects.toThrow("deadline");

    expect(metricsSnapshot().metrics["rung.sourcify"]).toMatchObject({ attempts: 1, misses: 1 });
    expect(metricsSnapshot().metrics["rung.heimdall"]).toMatchObject({ attempts: 1, failures: 1, last_error: "deadline" });
  });

  it("tracks best-effort misses without throwing", async () => {
    await expect(trackBestEffortMetric("rpc.debug_traceCall", async () => {
      throw new Error("method not available");
    }, () => "fallback")).resolves.toBe("fallback");

    expect(metricsSnapshot().metrics["rpc.debug_traceCall"]).toMatchObject({
      attempts: 1,
      successes: 0,
      misses: 1,
      failures: 0,
    });
  });
});
