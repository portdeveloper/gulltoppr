/**
 * prepare_tx (SPEC §3, §9) — the headline write verb. resolve → encode → simulate →
 * summarize → deeplink. Returns an UNSIGNED tx + its simulation + a human summary +
 * an abi.ninja signing deeplink + provenance-derived warnings. Never signs.
 */
import { encodeFunctionData, toFunctionSignature } from "viem";
import { config } from "../config.js";
import type { Call, PreparedTx, UnsignedTx } from "../types.js";
import { resolveAbiInternal } from "../resolve/index.js";
import { selectFunction } from "../resolve/selectFunction.js";
import { coerceArgs } from "./args.js";
import { requireFrom, simulate } from "./simulate.js";

function humanSummary(fn: string, address: string, args: unknown[]): string {
  const argStr = args.map((a) => (typeof a === "bigint" ? a.toString() : JSON.stringify(a))).join(", ");
  return `Call ${fn}(${argStr}) on ${address}.`;
}

function deeplink(chainId: number, address: string, fn: string, rawArgs: unknown[]): string {
  const args = encodeURIComponent(JSON.stringify(rawArgs));
  return `${config.abiNinjaBaseUrl}/${chainId}/${address}?function=${encodeURIComponent(fn)}&args=${args}`;
}

export async function prepareTx(call: Call, rpcOverride?: string): Promise<PreparedTx> {
  const from = requireFrom(call.from);
  const r = await resolveAbiInternal(call.chain, call.address, rpcOverride);
  const fn = selectFunction(r.abi, call.function);
  const args = coerceArgs(fn, call.args);
  const value = call.value ?? "0";

  const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args });
  const sim = await simulate(r.client, { from, to: call.address, data, value });

  const warnings: string[] = [];
  if (r.provenance.names_synthetic) {
    warnings.push(`ABI is ${r.provenance.confidence} — "${fn.name}" name is inferred; confirm this is the function you intend.`);
  }
  if (r.proxy) {
    warnings.push(`Target is a ${r.proxy.pattern} proxy; resolved against implementation ${r.abiFor}.`);
  }
  if (!sim.success) {
    warnings.push(`Simulation REVERTS: ${sim.revert?.reason ?? "unknown"} — sending this tx will fail.`);
  }
  if (value !== "0") {
    warnings.push(`Sends ${value} wei of native value.`);
  }

  const unsigned_tx: UnsignedTx = {
    chainId: r.chainId,
    to: call.address,
    from,
    data,
    value,
    ...(sim.gas_used ? { gas: String(Math.ceil(sim.gas_used * 1.2)) } : {}),
  };

  return {
    unsigned_tx,
    simulation: sim,
    human_summary: humanSummary(toFunctionSignature(fn), call.address, args),
    deeplink: deeplink(r.chainId, call.address, fn.name, call.args),
    warnings,
  };
}
