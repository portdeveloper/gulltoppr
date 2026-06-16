import { ApiError } from "./errors.js";

type Release = () => void;
type Waiter = {
  grant: () => void;
};

export class UpstreamConcurrency {
  private active = 0;
  private readonly queue: Waiter[] = [];

  constructor(private readonly maxConcurrency: number) {}

  async run<T>(label: string, queueTimeoutMs: number, task: () => Promise<T>): Promise<T> {
    const release = await this.acquire(label, queueTimeoutMs);
    try {
      return await task();
    } finally {
      release();
    }
  }

  private acquire(label: string, queueTimeoutMs: number): Promise<Release> {
    if (!Number.isFinite(this.maxConcurrency) || this.maxConcurrency <= 0) {
      return Promise.resolve(() => {});
    }

    if (this.active < this.maxConcurrency) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const waiter: Waiter = {
        grant: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.active += 1;
          resolve(() => this.release());
        },
      };

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(
          new ApiError("UPSTREAM_TIMEOUT", `${label} concurrency queue timed out after ${queueTimeoutMs}ms`, {
            max_concurrency: this.maxConcurrency,
          }),
        );
      }, Math.max(0, queueTimeoutMs));

      this.queue.push(waiter);
    });
  }

  private release(): void {
    if (!Number.isFinite(this.maxConcurrency) || this.maxConcurrency <= 0) return;
    if (this.active > 0) this.active -= 1;
    const next = this.queue.shift();
    if (next) next.grant();
  }
}
