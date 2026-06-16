import { describe, it, expect } from "vitest";
import {
  AbiNinja,
  AbiNinjaError,
  ENGINE_ERROR_CODES,
  filterContractInterface,
  Gulltoppr,
  hasBytecodeMatch,
  isHighFrictionProvenance,
  isLowRiskPreparedTx,
  provenanceWarnings,
  requireLowRiskWalletRequest,
  requireWalletRequest,
  searchContractMethods,
  type AbiResult,
  type PreparedTx,
  type Provenance,
} from "../src/index.js";

const BASE = "https://engine.test";
const ADDR = "0x0000000000000000000000000000000000000001" as `0x${string}`;
const TX_HASH = "0x000000000000000000000000000000000000000000000000000000000000dead";

/** A fake fetch that records calls and returns canned JSON; `handler` maps url → {status, body}. */
function fakeFetch(handler: (url: string) => { status?: number; body?: unknown; text?: string }) {
  const calls: { url: string; method: string; body: any }[] = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    });
    const { status = 200, body = {}, text } = handler(String(url)) ?? {};
    return new Response(text ?? JSON.stringify(body), { status, headers: { "content-type": text ? "application/x-ndjson" : "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe("Gulltoppr client", () => {
  it("exports engine error codes separately from SDK transport-only errors", () => {
    expect(ENGINE_ERROR_CODES).toEqual([
      "INVALID_ADDRESS",
      "INVALID_ARGS",
      "UNKNOWN_CHAIN",
      "AMBIGUOUS_FUNCTION",
      "FUNCTION_NOT_FOUND",
      "NOT_A_VIEW_FN",
      "NOT_A_WRITE_FN",
      "ABI_NOT_FOUND",
      "DECOMPILE_FAILED",
      "RPC_ERROR",
      "UPSTREAM_TIMEOUT",
      "RATE_LIMITED",
    ]);
    expect(new AbiNinjaError("NETWORK", "offline", 0).code).toBe("NETWORK");
  });

  it("discovery GETs the root discovery document", async () => {
    const { fn, calls } = fakeFetch(() => ({
      body: {
        name: "gulltoppr engine",
        verbs: ["resolve_abi", "prepare_tx"],
        mcp_utility_tools: ["list_chains"],
        safety_gate: { prepare_tx: "Only hand off when safety.signing_recommended is true." },
        integrations: { mcp_remote: "https://mcp.gulltoppr.dev/mcp" },
      },
    }));
    const discovery = await new Gulltoppr({ baseUrl: BASE, fetch: fn }).discovery();
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(`${BASE}/`);
    expect(discovery.verbs).toContain("prepare_tx");
    expect(discovery.safety_gate.prepare_tx).toContain("safety.signing_recommended");
    expect(discovery.integrations.mcp_remote).toBe("https://mcp.gulltoppr.dev/mcp");
  });

  it("chains GETs the chain catalog", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { chains: [{ id: 143, name: "Monad", aliases: ["monad"], testnet: false, has_default_rpc: true }] } }));
    const chains = await new Gulltoppr({ baseUrl: BASE, fetch: fn }).chains();
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(`${BASE}/v1/chains`);
    expect(chains[0]).toMatchObject({ id: 143, name: "Monad", testnet: false, has_default_rpc: true });
  });

  it("chains appends filter query params", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { chains: [] } }));
    await new Gulltoppr({ baseUrl: BASE, fetch: fn }).chains({ q: "bnb chain", testnets: false, hasDefaultRpc: true });
    expect(calls[0].url).toBe(`${BASE}/v1/chains?q=bnb+chain&testnets=false&has_default_rpc=true`);
  });

  it("metrics GETs runtime counters", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { uptime_seconds: 1, metrics: { "rung.etherscan": { attempts: 1 } } } }));
    const metrics = await new Gulltoppr({ baseUrl: BASE, fetch: fn }).metrics();
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(`${BASE}/v1/metrics`);
    expect(metrics.metrics["rung.etherscan"].attempts).toBe(1);
  });

  it("lookupSelector GETs the selector commons lookup route", async () => {
    const { fn, calls } = fakeFetch(() => ({
      body: {
        selector: "0xa9059cbb",
        entries: [{
          kind: "function",
          signature: "transfer(address,uint256)",
          proof: "verified-source",
          chain: 1,
          address: ADDR,
        }],
      },
    }));
    const result = await new Gulltoppr({ baseUrl: BASE, fetch: fn }).lookupSelector("0xa9059cbb");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(`${BASE}/v1/lookup/0xa9059cbb`);
    expect(result.entries[0]).toMatchObject({ signature: "transfer(address,uint256)", proof: "verified-source", chain: 1, address: ADDR });
  });

  it("registryStats GETs selector commons counts", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { selectors: { "function:verified-source": 2 }, bytecodes: 1 } }));
    const stats = await new Gulltoppr({ baseUrl: BASE, fetch: fn }).registryStats();
    expect(calls[0].url).toBe(`${BASE}/v1/registry/stats`);
    expect(stats.selectors["function:verified-source"]).toBe(2);
  });

  it("exportRegistry parses the CC0 NDJSON selector export", async () => {
    const line = JSON.stringify({
      selector: "0xa9059cbb",
      kind: "function",
      signature: "transfer(address,uint256)",
      proof: "verified-source",
    });
    const { fn, calls } = fakeFetch(() => ({ text: `${line}\n` }));
    const entries = await new Gulltoppr({ baseUrl: BASE, fetch: fn }).exportRegistry();
    expect(calls[0].url).toBe(`${BASE}/v1/registry/export`);
    expect(entries).toEqual([
      expect.objectContaining({ selector: "0xa9059cbb", signature: "transfer(address,uint256)" }),
    ]);
  });

  it("resolveAbi GETs the abi route and parses the body", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { address: ADDR, abi: [], provenance: { source: "etherscan" } } }));
    const r = await new Gulltoppr({ baseUrl: BASE, fetch: fn }).resolveAbi("ethereum", ADDR);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(`${BASE}/v1/ethereum/${ADDR}/abi`);
    expect(r.provenance.source).toBe("etherscan");
  });

  it("resolveManifest requests the compact resolve_abi response", async () => {
    const { fn, calls } = fakeFetch(() => ({
      body: { address: ADDR, abi_omitted: true, interface: { reads: [], writes: [] }, provenance: { source: "etherscan" } },
    }));
    const r = await new Gulltoppr({ baseUrl: BASE, fetch: fn }).resolveManifest("ethereum", ADDR);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(`${BASE}/v1/ethereum/${ADDR}/abi?include_abi=false`);
    expect(r.abi_omitted).toBe(true);
  });

  it("appends rpc_url as a query param", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: {} }));
    await new Gulltoppr({ baseUrl: BASE, fetch: fn }).resolveAbi("local", ADDR, { rpcUrl: "http://127.0.0.1:8545" });
    expect(calls[0].url).toContain("?rpc_url=http%3A%2F%2F127.0.0.1%3A8545");
  });

  it("resolveAbi can request a compact response while preserving rpc_url", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { abi_omitted: true } }));
    await new Gulltoppr({ baseUrl: BASE, fetch: fn }).resolveAbi("local", ADDR, {
      rpcUrl: "http://127.0.0.1:8545",
      includeAbi: false,
    });
    expect(calls[0].url).toBe(`${BASE}/v1/local/${ADDR}/abi?rpc_url=http%3A%2F%2F127.0.0.1%3A8545&include_abi=false`);
  });

  it("resolveManifest can request server-side method filtering", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { abi_omitted: true } }));
    await new Gulltoppr({ baseUrl: BASE, fetch: fn }).resolveManifest("base", ADDR, {
      q: "transfer uint256",
      kind: "write",
      limit: 10,
    });
    expect(calls[0].url).toBe(`${BASE}/v1/base/${ADDR}/abi?include_abi=false&method_q=transfer+uint256&method_kind=write&method_limit=10`);
  });

  it("read POSTs function + args", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { decoded: ["1"], raw: "0x" } }));
    await new Gulltoppr({ baseUrl: BASE, fetch: fn }).read("base", ADDR, "balanceOf", [ADDR]);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(`${BASE}/v1/base/${ADDR}/read`);
    expect(calls[0].body).toEqual({ function: "balanceOf", args: [ADDR] });
  });

  it("prepareTx POSTs function/args/from/value", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { unsigned_tx: {}, warnings: [] } }));
    await new Gulltoppr({ baseUrl: BASE, fetch: fn }).prepareTx("base", ADDR, "transfer", [ADDR, "1"], { from: ADDR, value: "0" });
    expect(calls[0].url).toBe(`${BASE}/v1/base/${ADDR}/prepare`);
    expect(calls[0].body).toEqual({ function: "transfer", args: [ADDR, "1"], from: ADDR, value: "0" });
  });

  it("searchContractMethods filters manifest methods by text, kind, hint, and limit", () => {
    const contractInterface = {
      reads: [
        {
          function: "balanceOf",
          signature: "balanceOf(address)",
          inputs: [{ name: "owner", type: "address" }],
          outputs: [{ name: "balance", type: "uint256" }],
          names_synthetic: false,
          hint: "wallet balance",
        },
        {
          function: "symbol",
          signature: "symbol()",
          inputs: [],
          outputs: [{ name: "", type: "string" }],
          names_synthetic: false,
        },
      ],
      writes: [
        {
          function: "transfer",
          signature: "transfer(address,uint256)",
          inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }],
          payable: false,
          names_synthetic: false,
          hint: "amount is in base units",
        },
        {
          function: "approve",
          signature: "approve(address,uint256)",
          inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }],
          payable: false,
          names_synthetic: false,
        },
      ],
    };

    expect(searchContractMethods(contractInterface, { q: "balance" }).map((match) => match.method.signature)).toEqual(["balanceOf(address)"]);
    expect(searchContractMethods(contractInterface, { q: "spender" }).map((match) => match.method.signature)).toEqual(["approve(address,uint256)"]);
    expect(searchContractMethods(contractInterface, { q: "base units", kind: "write" }).map((match) => match.method.signature)).toEqual(["transfer(address,uint256)"]);
    expect(searchContractMethods(contractInterface, { q: "transfer(address, uint256)" }).map((match) => match.method.signature)).toEqual(["transfer(address,uint256)"]);
    expect(searchContractMethods(contractInterface, { q: "transfer base units" }).map((match) => match.method.signature)).toEqual(["transfer(address,uint256)"]);
    expect(searchContractMethods(contractInterface, { q: "uint256", limit: 2 }).map((match) => `${match.kind}:${match.method.function}`)).toEqual([
      "read:balanceOf",
      "write:transfer",
    ]);

    expect(filterContractInterface(contractInterface, { kind: "write", q: "address" })).toEqual({
      reads: [],
      writes: contractInterface.writes,
    });
  });

  it("builds user-facing provenance warnings for SDK integrations", () => {
    const bytecodeMatched: Provenance = {
      source: "bytecode-match",
      confidence: "partial",
      verified: false,
      names_synthetic: false,
      natspec: false,
      bytecode_match: {
        chain: 1,
        address: "0x00000000000000000000000000000000000000A1",
        source: "etherscan",
        confidence: "verified",
      },
    };
    const decompiled: Provenance = {
      source: "heimdall-decompiled",
      confidence: "decompiled",
      verified: false,
      names_synthetic: true,
      natspec: false,
      notes: "Recovered 1 function name from the registry.",
    };

    expect(isHighFrictionProvenance(decompiled)).toBe(true);
    expect(hasBytecodeMatch(bytecodeMatched)).toBe(true);
    if (hasBytecodeMatch(bytecodeMatched)) {
      expect(bytecodeMatched.bytecode_match.source).toBe("etherscan");
    }

    expect(provenanceWarnings({
      provenance: bytecodeMatched,
      abi_omitted: true,
      abi_for: ADDR,
      proxy: {
        is_proxy: true,
        pattern: "eip1967",
        hops: [{ address: ADDR, role: "proxy" }, { address: ADDR, role: "implementation" }],
        resolved_implementation: ADDR,
      },
    })).toEqual([
      expect.stringContaining("Partial provenance"),
      expect.stringContaining("Bytecode match: ABI reused from 0x00000000000000000000000000000000000000A1 on chain 1"),
      expect.stringContaining("eip1967 proxy"),
      expect.stringContaining("Raw JSON ABI omitted"),
    ]);

    expect(provenanceWarnings({ provenance: decompiled })).toEqual([
      expect.stringContaining("Inferred ABI"),
    ]);
    expect(provenanceWarnings({
      provenance: { source: "etherscan", confidence: "verified", verified: true, names_synthetic: false, natspec: true },
    } as Pick<AbiResult, "provenance">)).toEqual([]);
  });

  it("simulate POSTs raw and high-level forms", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { success: true, gas_used: 0, state_diff: [], asset_changes: [], logs: [] } }));
    const client = new Gulltoppr({ baseUrl: BASE, fetch: fn });

    await client.simulate("base", { from: ADDR, to: ADDR, data: "0x1234", value: "0" });
    await client.simulate("base", { from: ADDR, address: ADDR, function: "balanceOf", args: [ADDR] });

    expect(calls[0].url).toBe(`${BASE}/v1/base/simulate`);
    expect(calls[0].body).toEqual({ from: ADDR, to: ADDR, data: "0x1234", value: "0" });
    expect(calls[1].body).toEqual({ from: ADDR, address: ADDR, function: "balanceOf", args: [ADDR] });
  });

  it("validates SDK call bodies before making a request", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: {} }));
    const client = new Gulltoppr({ baseUrl: BASE, fetch: fn });

    expect(() => client.resolveAbi("base", "not-an-address" as any)).toThrow("`address` must be a 0x address.");
    expect(() => client.resolveManifest("base", "not-an-address" as any)).toThrow("`address` must be a 0x address.");
    expect(() => client.lookupSelector("0x123")).toThrow("`selector` must be 0x + 8 hex chars or 0x + 64 hex chars.");
    expect(() => client.read("base", ADDR, "", [])).toThrow(AbiNinjaError);
    expect(() => client.encode("base", ADDR, "balanceOf", "bad" as any)).toThrow("`args` must be an array.");
    expect(() => client.prepareTx("base", ADDR, "transfer", [], { from: ADDR, value: "1.5" })).toThrow("`value` must be a decimal string in wei.");
    await expect(client.resolveManifest("base", ADDR, { kind: "event" as any })).rejects.toThrow("`kind` must be read, write, or all.");
    await expect(client.resolveManifest("base", ADDR, { limit: -1 })).rejects.toThrow("`limit` must be a non-negative integer <= 500.");
    expect(() => client.simulate("base", { from: ADDR, to: ADDR, data: "0x", address: ADDR, function: "transfer", args: [] } as any)).toThrow("simulate accepts either raw {to,data} or high-level {address,function,args}, not both.");
    expect(() => client.simulate("base", { from: ADDR, to: ADDR, data: "0x0" as any })).toThrow("`data` must be 0x-prefixed hex bytes.");
    expect(() => client.simulate("base", { from: ADDR } as any)).toThrow("simulate needs either {to,data} or {address,function,args}.");
    expect(() => client.decodeTx("base", "0xdead")).toThrow("`txHash` must be 0x + 64 hex chars.");
    await expect(client.resolveAbi("base", ADDR, { rpcUrl: "ws://rpc.example" })).rejects.toThrow("`rpcUrl` must be an http(s) URL.");
    await expect(client.resolveAbi("base", ADDR, { rpcUrl: "https://rpc.example/a b" })).rejects.toThrow("`rpcUrl` must be an http(s) URL.");
    expect(calls).toEqual([]);
  });

  it("requireWalletRequest returns only safety-gated wallet hand-offs", () => {
    const request = {
      chainId: 8453,
      method: "eth_sendTransaction",
      params: [{ from: ADDR, to: ADDR, data: "0x1234", value: "0x0" }],
    } as const;
    const prep = {
      wallet_request: request,
      safety: { signing_recommended: true, risk_level: "low", requires_human_confirmation: false, reasons: [] },
    } as unknown as PreparedTx;

    expect(requireWalletRequest(prep)).toBe(request);
  });

  it("requireWalletRequest still allows confirmation-required hand-offs when signing is recommended", () => {
    const request = {
      chainId: 8453,
      method: "eth_sendTransaction",
      params: [{ from: ADDR, to: ADDR, data: "0x1234", value: "0x0" }],
    } as const;
    const prep = {
      wallet_request: request,
      safety: {
        signing_recommended: true,
        risk_level: "medium",
        requires_human_confirmation: true,
        reasons: ["spending_approval"],
      },
    } as unknown as PreparedTx;

    expect(requireWalletRequest(prep)).toBe(request);
  });

  it("requireLowRiskWalletRequest blocks confirmation-required hand-offs", () => {
    const request = {
      chainId: 8453,
      method: "eth_sendTransaction",
      params: [{ from: ADDR, to: ADDR, data: "0x1234", value: "0x0" }],
    } as const;
    const low = {
      wallet_request: request,
      safety: { signing_recommended: true, risk_level: "low", requires_human_confirmation: false, reasons: [] },
    } as unknown as PreparedTx;
    const approval = {
      wallet_request: request,
      safety: {
        signing_recommended: true,
        risk_level: "medium",
        requires_human_confirmation: true,
        reasons: ["spending_approval"],
      },
    } as unknown as PreparedTx;
    const blocked = {
      safety: {
        signing_recommended: false,
        risk_level: "blocked",
        requires_human_confirmation: true,
        reasons: ["simulation_failed"],
      },
    } as unknown as PreparedTx;

    expect(isLowRiskPreparedTx(low)).toBe(true);
    expect(requireLowRiskWalletRequest(low)).toBe(request);
    expect(isLowRiskPreparedTx(approval)).toBe(false);
    expect(() => requireLowRiskWalletRequest(approval)).toThrow("requires human confirmation");
    expect(() => requireLowRiskWalletRequest(blocked)).toThrow("requires human confirmation");
  });

  it("requireWalletRequest blocks failed or legacy hand-offs", () => {
    const blocked = {
      safety: {
        signing_recommended: false,
        risk_level: "blocked",
        requires_human_confirmation: true,
        reasons: ["simulation_failed"],
      },
    } as unknown as PreparedTx;
    const missing = {
      safety: { signing_recommended: true, risk_level: "low", requires_human_confirmation: false, reasons: [] },
    } as unknown as PreparedTx;
    const legacy = {
      wallet_request: {
        chainId: 8453,
        method: "eth_sendTransaction",
        params: [{ from: ADDR, to: ADDR, data: "0x1234", value: "0x0" }],
      },
    } as unknown as PreparedTx;
    const malformed = {
      wallet_request: legacy.wallet_request,
      safety: { signing_recommended: true, risk_level: "low", requires_human_confirmation: false },
    } as unknown as PreparedTx;

    expect(() => requireWalletRequest(blocked)).toThrow(AbiNinjaError);
    expect(() => requireWalletRequest(missing)).toThrow("did not include wallet_request");
    expect(isLowRiskPreparedTx(legacy)).toBe(false);
    expect(() => requireWalletRequest(legacy)).toThrow("did not include safety metadata");
    expect(() => requireLowRiskWalletRequest(legacy)).toThrow("did not include safety metadata");
    expect(() => requireWalletRequest(malformed)).toThrow("did not include safety metadata");
  });

  it("decodeTx GETs the tx route", async () => {
    const { fn, calls } = fakeFetch(() => ({
      body: { chain: 1, tx_hash: TX_HASH, source: "heimdall-decoded", cached: false, decoded: {}, provenance: {} },
    }));
    const decoded = await new Gulltoppr({ baseUrl: BASE, fetch: fn }).decodeTx("ethereum", TX_HASH);
    const typedHash: `0x${string}` = decoded.tx_hash;
    expect(calls[0].url).toBe(`${BASE}/v1/ethereum/tx/${TX_HASH}`);
    expect(typedHash).toBe(TX_HASH);
  });

  it("resolveName routes name vs address to the right endpoint", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: {} }));
    const n = new Gulltoppr({ baseUrl: BASE, fetch: fn });
    await n.resolveName("vitalik.eth");
    await n.resolveName(ADDR);
    expect(calls[0].url).toBe(`${BASE}/v1/ethereum/name/vitalik.eth`);
    expect(calls[1].url).toBe(`${BASE}/v1/ethereum/name/by-address/${ADDR}`);
  });

  it("throws AbiNinjaError carrying the engine's code + status", async () => {
    const { fn } = fakeFetch(() => ({ status: 404, body: { error: { code: "FUNCTION_NOT_FOUND", message: "no fn" } } }));
    const n = new Gulltoppr({ baseUrl: BASE, fetch: fn });
    await expect(n.read("base", ADDR, "nope", [])).rejects.toMatchObject({
      name: "AbiNinjaError",
      code: "FUNCTION_NOT_FOUND",
      status: 404,
    });
  });

  it("maps transport failures to a NETWORK error", async () => {
    const fn = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await expect(new Gulltoppr({ baseUrl: BASE, fetch: fn }).resolveAbi("base", ADDR)).rejects.toBeInstanceOf(AbiNinjaError);
  });

  it("contract() memoizes resolve (one network call for two resolves)", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { address: ADDR, abi: [], provenance: {} } }));
    const c = new Gulltoppr({ baseUrl: BASE, fetch: fn }).contract("base", ADDR);
    await c.resolve();
    await c.resolve();
    expect(calls.filter((x) => x.url.endsWith("/abi")).length).toBe(1);
  });

  it("contract() simulates high-level calls against the contract address", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { success: true, gas_used: 21000, state_diff: [], asset_changes: [], logs: [] } }));
    const c = new Gulltoppr({ baseUrl: BASE, fetch: fn }).contract("local", ADDR);
    await c.simulate("transfer", [ADDR, "1"], {
      from: ADDR,
      value: "0",
      rpcUrl: "http://127.0.0.1:8545",
    });

    expect(calls[0].url).toBe(`${BASE}/v1/local/simulate?rpc_url=http%3A%2F%2F127.0.0.1%3A8545`);
    expect(calls[0].body).toEqual({
      from: ADDR,
      address: ADDR,
      function: "transfer",
      args: [ADDR, "1"],
      value: "0",
    });
  });

  it("contract() memoizes resolve per rpcUrl override", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { address: ADDR, abi: [], provenance: {} } }));
    const c = new Gulltoppr({ baseUrl: BASE, fetch: fn }).contract("local", ADDR);
    const opts = { rpcUrl: "http://127.0.0.1:8545" };

    await c.resolve();
    await c.resolve(opts);
    await c.resolve(opts);

    expect(calls.map((x) => x.url)).toEqual([
      `${BASE}/v1/local/${ADDR}/abi`,
      `${BASE}/v1/local/${ADDR}/abi?rpc_url=http%3A%2F%2F127.0.0.1%3A8545`,
    ]);
  });

  it("contract() does not memoize a failed resolve", async () => {
    let attempts = 0;
    const { fn, calls } = fakeFetch(() => {
      attempts += 1;
      if (attempts === 1) {
        return { status: 503, body: { error: { code: "UPSTREAM_ERROR", message: "temporary" } } };
      }
      return { body: { address: ADDR, abi: [], provenance: {} } };
    });
    const c = new Gulltoppr({ baseUrl: BASE, fetch: fn }).contract("base", ADDR);

    await expect(c.resolve()).rejects.toMatchObject({ code: "UPSTREAM_ERROR", status: 503 });
    await expect(c.resolve()).resolves.toMatchObject({ address: ADDR });
    expect(calls.filter((x) => x.url.endsWith("/abi")).length).toBe(2);
  });

  it("defaults baseUrl to the live engine", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: {} }));
    await new Gulltoppr({ fetch: fn }).resolveName("vitalik.eth");
    expect(calls[0].url.startsWith("https://api.gulltoppr.dev/")).toBe(true);
  });

  it("keeps AbiNinja as a backwards-compatible alias", async () => {
    const { fn, calls } = fakeFetch(() => ({ body: {} }));
    await new AbiNinja({ baseUrl: BASE, fetch: fn }).resolveName("vitalik.eth");
    expect(calls[0].url).toBe(`${BASE}/v1/ethereum/name/vitalik.eth`);
  });
});
