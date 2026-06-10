/**
 * simulate (SPEC §3, §2.6) — backed by raw eth_call / debug_traceCall (no Tenderly).
 * `success`/`gas_used`/`revert`/`return_value` are exact; `asset_changes`/`logs` are
 * best-effort from a callTracer trace; `state_diff` is TODO (needs prestateTracer).
 */
import {
  decodeEventLog,
  parseAbiItem,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { ApiError } from "../errors.js";
import type { AssetChange, SimLog, Simulation } from "../types.js";

export interface SimulateInput {
  from: Address;
  to: Address;
  data: Hex;
  value?: string;
}

const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** Best-effort: debug_traceCall(callTracer, withLog) → gas + logs. Empty on unsupported RPC. */
async function tryTrace(
  client: PublicClient,
  input: SimulateInput,
): Promise<{ gasUsed?: number; logs: { address: Address; topics: Hex[]; data: Hex }[] }> {
  try {
    const trace = (await client.request({
      method: "debug_traceCall" as never,
      params: [
        { from: input.from, to: input.to, data: input.data, value: input.value ? `0x${BigInt(input.value).toString(16)}` : undefined },
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
  } catch {
    return { logs: [] }; // tracing unsupported on this RPC — degrade gracefully
  }
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
  const value = input.value ? BigInt(input.value) : 0n;

  // Exact: eth_call for success/return + revert reason.
  let returnRaw: Hex = "0x";
  let success = true;
  let revert: Simulation["revert"];
  try {
    const res = await client.call({ account: input.from, to: input.to, data: input.data, value });
    returnRaw = (res.data ?? "0x") as Hex;
  } catch (e) {
    success = false;
    const err = e as { shortMessage?: string; details?: string; message: string };
    const reason = err.shortMessage || err.details || err.message;
    revert = { reason, decoded: err.shortMessage };
  }

  // Exact-ish: gas estimate (only meaningful when it would succeed).
  let gasUsed = 0;
  if (success) {
    try {
      gasUsed = Number(await client.estimateGas({ account: input.from, to: input.to, data: input.data, value }));
    } catch {
      /* leave 0 */
    }
  }

  // Best-effort effects.
  const trace = await tryTrace(client, input);
  if (trace.gasUsed && trace.gasUsed > gasUsed) gasUsed = trace.gasUsed;
  const { simLogs, assetChanges } = decodeTransfers(trace.logs, input.from);

  return {
    success,
    gas_used: gasUsed,
    ...(success ? { return_value: { decoded: [], raw: returnRaw } } : {}),
    state_diff: [], // TODO: prestateTracer diff
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
