import { afterEach, describe, expect, it, vi } from "vitest";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("heimdall client", () => {
  it("times out queued decompile work before starting another gulltoppr fetch", async () => {
    vi.stubEnv("HEIMDALL_API_URL", "https://heimdall.test");
    vi.stubEnv("HEIMDALL_CONCURRENCY", "1");
    vi.stubEnv("HEIMDALL_QUEUE_TIMEOUT_MS", "5");
    vi.stubEnv("HEIMDALL_TIMEOUT_MS", "1000");

    const fetch = vi.fn(async () => {
      await sleep(25);
      return new Response(
        JSON.stringify({
          cached: false,
          abi: [{ type: "function", name: "foo", stateMutability: "view", inputs: [], outputs: [] }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetch);

    const { fromHeimdall } = await import("../src/resolve/heimdall.js");
    const address = "0x0000000000000000000000000000000000000001";
    const rpcUrl = "https://rpc.test";

    const first = fromHeimdall(address, rpcUrl);
    const second = fromHeimdall(address, rpcUrl);

    await expect(second).rejects.toMatchObject({
      code: "UPSTREAM_TIMEOUT",
      details: { max_concurrency: 1 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(first).resolves.toMatchObject({ cached: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
