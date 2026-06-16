import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("Etherscan rung", () => {
  it("budgets calls to the shared Etherscan key and skips when exhausted", async () => {
    vi.stubEnv("ETHERSCAN_API_KEY", "test-key");
    vi.stubEnv("ETHERSCAN_RATE_LIMIT", "1");
    vi.stubEnv("ETHERSCAN_RATE_WINDOW_SEC", "60");

    const fetch = vi.fn(async () =>
      new Response(JSON.stringify({ status: "0", result: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const { fromEtherscan } = await import("../src/resolve/etherscan.js");
    const address = "0x0000000000000000000000000000000000000001";

    await expect(fromEtherscan(1, address)).resolves.toBeNull();
    await expect(fromEtherscan(1, address)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not call Etherscan when no API key is configured", async () => {
    vi.stubEnv("ETHERSCAN_API_KEY", "");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    const { fromEtherscan } = await import("../src/resolve/etherscan.js");
    await expect(fromEtherscan(1, "0x0000000000000000000000000000000000000001")).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
});
