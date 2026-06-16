import { performance } from "node:perf_hooks";

export type MetricOutcome = "success" | "miss" | "failure";

export interface MetricBucket {
  attempts: number;
  successes: number;
  misses: number;
  failures: number;
  total_latency_ms: number;
  avg_latency_ms: number;
  max_latency_ms: number;
  failure_rate: number;
  last_error?: string;
}

const startedAt = Date.now();
const buckets = new Map<string, Omit<MetricBucket, "avg_latency_ms" | "failure_rate">>();

function bucket(name: string): Omit<MetricBucket, "avg_latency_ms" | "failure_rate"> {
  let b = buckets.get(name);
  if (!b) {
    b = {
      attempts: 0,
      successes: 0,
      misses: 0,
      failures: 0,
      total_latency_ms: 0,
      max_latency_ms: 0,
    };
    buckets.set(name, b);
  }
  return b;
}

export function recordMetric(name: string, outcome: MetricOutcome, latencyMs: number, error?: unknown): void {
  const b = bucket(name);
  b.attempts++;
  b.total_latency_ms += latencyMs;
  b.max_latency_ms = Math.max(b.max_latency_ms, latencyMs);
  if (outcome === "success") b.successes++;
  if (outcome === "miss") b.misses++;
  if (outcome === "failure") {
    b.failures++;
    b.last_error = error instanceof Error ? error.message : String(error ?? "unknown");
  }
}

export async function trackMetric<T>(
  name: string,
  fn: () => Promise<T>,
  classify: (value: T) => MetricOutcome = (value) => (value == null ? "miss" : "success"),
): Promise<T> {
  const start = performance.now();
  try {
    const value = await fn();
    recordMetric(name, classify(value), performance.now() - start);
    return value;
  } catch (error) {
    recordMetric(name, "failure", performance.now() - start, error);
    throw error;
  }
}

export async function trackBestEffortMetric<T>(
  name: string,
  fn: () => Promise<T>,
  fallback: (error: unknown) => T,
  outcome: MetricOutcome = "miss",
): Promise<T> {
  const start = performance.now();
  try {
    const value = await fn();
    recordMetric(name, "success", performance.now() - start);
    return value;
  } catch (error) {
    recordMetric(name, outcome, performance.now() - start, error);
    return fallback(error);
  }
}

export function metricsSnapshot(): { uptime_seconds: number; metrics: Record<string, MetricBucket> } {
  const metrics: Record<string, MetricBucket> = {};
  for (const [name, b] of buckets) {
    metrics[name] = {
      ...b,
      total_latency_ms: Math.round(b.total_latency_ms),
      avg_latency_ms: b.attempts ? Math.round(b.total_latency_ms / b.attempts) : 0,
      max_latency_ms: Math.round(b.max_latency_ms),
      failure_rate: b.attempts ? b.failures / b.attempts : 0,
    };
  }
  return {
    uptime_seconds: Math.floor((Date.now() - startedAt) / 1000),
    metrics,
  };
}

export function resetMetricsForTests(): void {
  buckets.clear();
}
