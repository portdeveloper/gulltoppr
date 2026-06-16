/**
 * simulate (SPEC §3, §2.6) — backed by raw eth_call / debug_traceCall (no Tenderly).
 * `success`/`gas_used`/`revert`/`return_value` are exact; `asset_changes`/`logs` are
 * best-effort from callTracer; `state_diff` is best-effort from prestateTracer
 * diffMode. Unsupported debug APIs degrade to empty arrays.
 */
import { performance } from "node:perf_hooks";
import {
  decodeEventLog,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { ApiError } from "../errors.js";
import type { AssetChange, SimLog, Simulation, StateDiffEntry } from "../types.js";
import { recordMetric, trackBestEffortMetric } from "../metrics.js";

export interface SimulateInput {
  from: Address;
  to: Address;
  data: Hex;
  value?: string;
}

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const NATIVE_TOKEN = "0x0000000000000000000000000000000000000000" as Address;
const ZERO = "0x0";

function parseWeiValue(value: string | undefined): bigint {
  if (value === undefined) return 0n;
  if (!/^\d+$/.test(value)) {
    throw new ApiError("INVALID_ARGS", "`value` must be a decimal string in wei.");
  }
  return BigInt(value);
}

function traceValue(value: string | undefined): Hex | undefined {
  const wei = parseWeiValue(value);
  return wei > 0n ? (`0x${wei.toString(16)}` as Hex) : undefined;
}

/** Best-effort: debug_traceCall(callTracer, withLog) → gas + logs. Empty on unsupported RPC. */
async function tryTrace(
  client: PublicClient,
  input: SimulateInput,
): Promise<{ gasUsed?: number; logs: { address: Address; topics: Hex[]; data: Hex }[] }> {
  return trackBestEffortMetric("rpc.debug_traceCall.callTracer", async () => {
    const trace = (await client.request({
      method: "debug_traceCall" as never,
      params: [
        { from: input.from, to: input.to, data: input.data, value: traceValue(input.value) },
        "latest",
        { tracer: "callTracer", tracerConfig: { withLog: true } },
      ] as never,
    })) as { gasUsed?: string; logs?: { address: Address; topics: Hex[]; data: Hex }[] };

    const logs: { address: Address; topics: Hex[]; data: Hex }[] = [];
    const collect = (node: { logs?: typeof logs; calls?: unknown[] }) => {
      if (node.logs) logs.push(...node.logs);
      if (Array.isArray(node.calls)) node.calls.forEach((c) => collect(c as typeof node));
    };
    collect(trace as never);

    return { gasUsed: trace.gasUsed ? Number(BigInt(trace.gasUsed)) : undefined, logs };
  }, () => ({ gasUsed: undefined, logs: [] })); // tracing unsupported on this RPC — degrade gracefully
}

interface PrestateAccount {
  balance?: string;
  nonce?: number | string;
  storage?: Record<string, string>;
}

interface PrestateDiff {
  pre?: Record<string, PrestateAccount>;
  post?: Record<string, PrestateAccount>;
}

function formatDiffValue(value: unknown): string {
  if (value === undefined || value === null) return ZERO;
  return typeof value === "string" ? value : String(value);
}

function pushAccountFieldDiff(
  entries: StateDiffEntry[],
  address: Address,
  slotLabel: string,
  before: unknown,
  after: unknown,
): void {
  const b = formatDiffValue(before);
  const a = formatDiffValue(after);
  if (b !== a) entries.push({ address, slot_label: slotLabel, before: b, after: a });
}

function stateDiffFromPrestate(trace: PrestateDiff): StateDiffEntry[] {
  const entries: StateDiffEntry[] = [];
  const pre = trace.pre ?? {};
  const post = trace.post ?? {};
  const addresses = new Set([...Object.keys(pre), ...Object.keys(post)]);

  for (const rawAddress of addresses) {
    const address = rawAddress as Address;
    const before = pre[rawAddress];
    const after = post[rawAddress];
    const accountDeleted = Boolean(before && !after);
    const accountCreated = Boolean(!before && after);
    if (accountDeleted || accountCreated || after?.balance !== undefined) {
      pushAccountFieldDiff(entries, address, "balance", before?.balance, after?.balance);
    }
    if (accountDeleted || accountCreated || after?.nonce !== undefined) {
      pushAccountFieldDiff(entries, address, "nonce", before?.nonce, after?.nonce);
    }

    const beforeStorage = before?.storage ?? {};
    const afterStorage = after?.storage ?? {};
    const slots = new Set([...Object.keys(beforeStorage), ...Object.keys(afterStorage)]);
    for (const slot of slots) {
      pushAccountFieldDiff(entries, address, slot, beforeStorage[slot], afterStorage[slot]);
    }
  }

  return entries;
}

/** Best-effort: debug_traceCall(prestateTracer diffMode) → modified balance/nonce/storage. */
async function tryStateDiff(client: PublicClient, input: SimulateInput): Promise<StateDiffEntry[]> {
  return trackBestEffortMetric("rpc.debug_traceCall.prestateTracer", async () => {
    const trace = (await client.request({
      method: "debug_traceCall" as never,
      params: [
        { from: input.from, to: input.to, data: input.data, value: traceValue(input.value) },
        "latest",
        { tracer: "prestateTracer", tracerConfig: { diffMode: true, disableCode: true } },
      ] as never,
    })) as PrestateDiff;
    return stateDiffFromPrestate(trace);
  }, () => []);
}

function decodeTransfers(
  logs: { address: Address; topics: Hex[]; data: Hex }[],
  from: Address,
): { simLogs: SimLog[]; assetChanges: AssetChange[] } {
  const simLogs: SimLog[] = [];
  const assetChanges: AssetChange[] = [];
  for (const log of logs) {
    try {
      const decoded = decodeEventLog({ abi: [TRANSFER_EVENT], topics: log.topics as [Hex, ...Hex[]], data: log.data });
      const a = decoded.args as unknown as { from: Address; to: Address; value: bigint };
      simLogs.push({ address: log.address, event: "Transfer(address,address,uint256)", args: { from: a.from, to: a.to, value: a.value.toString() } });
      if (a.from.toLowerCase() === from.toLowerCase()) {
        assetChanges.push({ address: from, token: log.address, delta: `-${a.value.toString()}`, kind: "erc20" });
      }
      if (a.to.toLowerCase() === from.toLowerCase()) {
        assetChanges.push({ address: from, token: log.address, delta: a.value.toString(), kind: "erc20" });
      }
    } catch {
      simLogs.push({ address: log.address });
    }
  }
  return { simLogs, assetChanges };
}

export async function simulate(client: PublicClient, input: SimulateInput): Promise<Simulation> {
  const value = parseWeiValue(input.value);
  const normalizedInput = { ...input, value: value.toString() };

  // Exact: eth_call for success/return + revert reason.
  let returnRaw: Hex = "0x";
  let success = true;
  let revert: Simulation["revert"];
  const callStart = performance.now();
  try {
    const res = await client.call({ account: input.from, to: input.to, data: input.data, value });
    recordMetric("rpc.eth_call.simulate", "success", performance.now() - callStart);
    returnRaw = (res.data ?? "0x") as Hex;
  } catch (e) {
    recordMetric("rpc.eth_call.simulate", "miss", performance.now() - callStart, e);
    success = false;
    const err = e as { shortMessage?: string; details?: string; message: string };
    const reason = err.shortMessage || err.details || err.message;
    revert = { reason, decoded: err.shortMessage };
  }

  // Exact-ish: gas estimate (only meaningful when it would succeed).
  let gasUsed = 0;
  if (success) {
    const estimated = await trackBestEffortMetric(
      "rpc.estimateGas.simulate",
      () => client.estimateGas({ account: input.from, to: input.to, data: input.data, value }),
      () => 0n,
    );
    gasUsed = Number(estimated);
  }

  // Best-effort effects.
  const trace = await tryTrace(client, normalizedInput);
  if (trace.gasUsed && trace.gasUsed > gasUsed) gasUsed = trace.gasUsed;
  const { simLogs, assetChanges } = decodeTransfers(trace.logs, input.from);
  const stateDiff = await tryStateDiff(client, normalizedInput);
  if (value > 0n) {
    assetChanges.push({
      address: input.from,
      token: NATIVE_TOKEN,
      delta: `-${value.toString()}`,
      kind: "native",
    });
  }

  return {
    success,
    gas_used: gasUsed,
    ...(success ? { return_value: { decoded: [], raw: returnRaw } } : {}),
    state_diff: stateDiff,
    asset_changes: assetChanges,
    logs: simLogs,
    ...(revert ? { revert } : {}),
  };
}

/** Guard so callers pass a sane address. */
export function requireFrom(from: string | undefined): Address {
  if (!from || !/^0x[0-9a-fA-F]{40}$/.test(from)) {
    throw new ApiError("INVALID_ARGS", "simulate/prepare_tx require a valid `from` address.");
  }
  return from as Address;
}
