/**
 * prepare_tx (SPEC §3, §9) — the headline write verb. resolve → encode → simulate →
 * summarize → hand-off. Returns an UNSIGNED tx + its simulation + a human summary +
 * a configured signing deeplink / wallet request + provenance-derived warnings. Never signs.
 */
import { encodeFunctionData, toFunctionSignature, toHex, type AbiFunction } from "viem";
import { config } from "../config.js";
import type { Call, PreparedTx, PreparedTxRiskLevel, PreparedTxSafetyReason, UnsignedTx, WalletRequest } from "../types.js";
import { resolveAbiInternal } from "../resolve/index.js";
import { requireWrite, selectFunction } from "../resolve/selectFunction.js";
import { coerceArgs } from "./args.js";
import { requireFrom, simulate } from "./simulate.js";
import { safeStringify } from "../util.js";
import { ApiError } from "../errors.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function summarizeArg(arg: unknown): string {
  return typeof arg === "bigint" ? arg.toString() : safeStringify(arg);
}

function humanSummary(fn: string, address: string, args: unknown[], value: string): string {
  const argStr = args.map(summarizeArg).join(", ");
  const nativeValue = value !== "0" ? ` with ${value} wei native value` : "";
  return `Call ${fn}(${argStr}) on ${address}${nativeValue}.`;
}

// Optional convenience signing surface. SIGNING_BASE_URL controls the deeplink;
// set it to "" to omit the deeplink entirely and rely on `wallet_request` /
// `unsigned_tx`. gulltoppr does not depend on the linked signing UI.
function deeplink(chainId: number, address: string, fn: string, rawArgs: unknown[]): string {
  if (!config.signingBaseUrl) return "";
  const args = encodeURIComponent(JSON.stringify(rawArgs));
  return `${config.signingBaseUrl}/${chainId}/${address}?function=${encodeURIComponent(fn)}&args=${args}`;
}

function walletRequest(tx: UnsignedTx): WalletRequest {
  return {
    chainId: tx.chainId,
    method: "eth_sendTransaction",
    params: [
      {
        from: tx.from,
        to: tx.to,
        data: tx.data,
        value: toHex(BigInt(tx.value)),
        ...(tx.gas ? { gas: toHex(BigInt(tx.gas)) } : {}),
      },
    ],
  };
}

function normalizeWeiValue(value: string | undefined): string {
  if (value === undefined) return "0";
  if (!/^\d+$/.test(value)) {
    throw new ApiError("INVALID_ARGS", "`value` must be a decimal string in wei.");
  }
  return BigInt(value).toString();
}

function simulatedAssetOutflowWarnings(from: string, assetChanges: PreparedTx["simulation"]["asset_changes"]): string[] {
  const sender = from.toLowerCase();
  return assetChanges
    .filter((change) =>
      change.address.toLowerCase() === sender &&
      change.kind !== "native" &&
      /^-\d+$/.test(change.delta) &&
      change.delta !== "-0",
    )
    .slice(0, 5)
    .map((change) => {
      const symbol = change.symbol ? ` ${change.symbol}` : "";
      return `Simulation shows ${change.delta}${symbol} ${change.kind} outflow from ${change.address} (${change.token}).`;
    });
}

function functionSignatures(functions: AbiFunction[]): Set<string> {
  const signatures = new Set<string>();
  for (const candidate of functions) {
    signatures.add(functionSignature(candidate));
  }
  return signatures;
}

function functionSignature(fn: AbiFunction): string {
  try {
    return toFunctionSignature(fn);
  } catch {
    return `${fn.name}(${(fn.inputs ?? []).map((input) => input.type).join(",")})`;
  }
}

function positiveAmount(value: unknown): string | undefined {
  if (typeof value !== "bigint") return undefined;
  return value > 0n ? value.toString() : undefined;
}

function decimalInteger(value: unknown): string | undefined {
  return typeof value === "bigint" && value >= 0n ? value.toString() : undefined;
}

function likelyErc20(functions: AbiFunction[]): boolean {
  const signatures = functionSignatures(functions);
  return signatures.has("balanceOf(address)") && signatures.has("transfer(address,uint256)");
}

function likelyErc721(functions: AbiFunction[]): boolean {
  const signatures = functionSignatures(functions);
  return (
    signatures.has("ownerOf(uint256)") &&
    (signatures.has("transferFrom(address,address,uint256)") ||
      signatures.has("safeTransferFrom(address,address,uint256)"))
  );
}

function likelyErc1155(functions: AbiFunction[]): boolean {
  const signatures = functionSignatures(functions);
  return (
    signatures.has("balanceOf(address,uint256)") &&
    (signatures.has("safeTransferFrom(address,address,uint256,uint256,bytes)") ||
      signatures.has("safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)"))
  );
}

function addressArg(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonzeroAddress(value: unknown): string | undefined {
  const address = addressArg(value);
  return address && address.toLowerCase() !== ZERO_ADDRESS ? address : undefined;
}

function bigintArray(value: unknown): bigint[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "bigint") ? value : undefined;
}

function standardTokenOutflowWarnings(
  from: string,
  token: string,
  fn: AbiFunction,
  args: unknown[],
  functions: AbiFunction[],
): string[] {
  const signature = functionSignature(fn);
  if (likelyErc20(functions) && signature === "transfer(address,uint256)") {
    const to = addressArg(args[0]);
    const amount = positiveAmount(args[1]);
    if (to && amount) return [`Call transfers ${amount} erc20 units from ${from} to ${to} (${token}).`];
  }

  if (
    likelyErc721(functions) &&
    (signature === "transferFrom(address,address,uint256)" ||
      signature === "safeTransferFrom(address,address,uint256)")
  ) {
    const source = addressArg(args[0]);
    const to = addressArg(args[1]);
    const tokenId = decimalInteger(args[2]);
    if (source && to && tokenId) return [`Call transfers erc721 token ${tokenId} from ${source} to ${to} (${token}).`];
  }

  if (likelyErc1155(functions) && signature === "safeTransferFrom(address,address,uint256,uint256,bytes)") {
    const source = addressArg(args[0]);
    const to = addressArg(args[1]);
    const tokenId = decimalInteger(args[2]);
    const amount = positiveAmount(args[3]);
    if (source && to && tokenId && amount) {
      return [`Call transfers ${amount} erc1155 units of token ${tokenId} from ${source} to ${to} (${token}).`];
    }
  }

  if (likelyErc1155(functions) && signature === "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)") {
    const source = addressArg(args[0]);
    const to = addressArg(args[1]);
    const ids = bigintArray(args[2]);
    const amounts = bigintArray(args[3]);
    if (source && to && ids?.length && amounts?.length && ids.length === amounts.length && amounts.some((amount) => amount > 0n)) {
      return [
        `Call transfers erc1155 batch from ${source} to ${to} (${token}): ids [${ids.join(",")}], amounts [${amounts.join(",")}].`,
      ];
    }
  }

  return [];
}

function standardApprovalWarnings(
  token: string,
  fn: AbiFunction,
  args: unknown[],
  functions: AbiFunction[],
): string[] {
  const signature = functionSignature(fn);

  if (likelyErc20(functions) && signature === "approve(address,uint256)") {
    const spender = nonzeroAddress(args[0]);
    const amount = positiveAmount(args[1]);
    if (spender && amount) return [`Call approves ${spender} to spend ${amount} erc20 units from the signer (${token}).`];
  }

  if (likelyErc20(functions) && signature === "increaseAllowance(address,uint256)") {
    const spender = nonzeroAddress(args[0]);
    const amount = positiveAmount(args[1]);
    if (spender && amount) return [`Call increases ${spender}'s erc20 allowance by ${amount} units from the signer (${token}).`];
  }

  if (likelyErc721(functions) && signature === "approve(address,uint256)") {
    const operator = nonzeroAddress(args[0]);
    const tokenId = decimalInteger(args[1]);
    if (operator && tokenId) return [`Call approves ${operator} to transfer erc721 token ${tokenId} (${token}).`];
  }

  if (
    (likelyErc721(functions) || likelyErc1155(functions)) &&
    signature === "setApprovalForAll(address,bool)" &&
    args[1] === true
  ) {
    const operator = nonzeroAddress(args[0]);
    if (operator) return [`Call approves ${operator} to transfer all tokens for this collection (${token}).`];
  }

  return [];
}

function highFrictionAbiConfidence(confidence: string): boolean {
  return confidence === "decompiled" || confidence === "selector-only";
}

export async function prepareTx(call: Call, rpcOverride?: string): Promise<PreparedTx> {
  const from = requireFrom(call.from);
  const r = await resolveAbiInternal(call.chain, call.address, rpcOverride);
  const fn = selectFunction(r.abi, call.function);
  requireWrite(fn);
  const args = coerceArgs(fn, call.args);
  const value = normalizeWeiValue(call.value);

  const data = encodeFunctionData({ abi: [fn], functionName: fn.name, args });
  const sim = await simulate(r.client, { from, to: call.address, data, value });

  const warnings: string[] = [];
  const safetyReasons: PreparedTxSafetyReason[] = [];
  if (r.provenance.names_synthetic || highFrictionAbiConfidence(r.provenance.confidence)) {
    safetyReasons.push("abi_names_inferred");
    warnings.push(
      `High-friction write: ABI confidence is ${r.provenance.confidence} — "${fn.name}" names or mutability may be inferred; confirm the selector and intent before signing.`,
    );
  }
  if (r.proxy) {
    safetyReasons.push("proxy");
    if (r.proxy.pattern === "diamond") {
      const facets = r.proxy.hops.filter((hop) => hop.role === "facet").length;
      warnings.push(`Target is a diamond proxy; ABI is merged from ${facets} facet(s).`);
    } else {
      warnings.push(`Target is a ${r.proxy.pattern} proxy; resolved against implementation ${r.abiFor}.`);
    }
  }
  if (!sim.success) {
    safetyReasons.push("simulation_failed");
    warnings.push(`Simulation REVERTS: ${sim.revert?.reason ?? "unknown"} — do not send this transaction.`);
  }
  if (value !== "0") {
    safetyReasons.push("native_value");
    warnings.push(`Sends ${value} wei of native value.`);
  }
  const approvalWarnings = standardApprovalWarnings(call.address, fn, args, r.functions);
  if (approvalWarnings.length) {
    safetyReasons.push("spending_approval");
    warnings.push(...approvalWarnings);
  }
  const outflowWarnings = simulatedAssetOutflowWarnings(from, sim.asset_changes);
  const inferredOutflowWarnings = outflowWarnings.length ? [] : standardTokenOutflowWarnings(from, call.address, fn, args, r.functions);
  const allOutflowWarnings = [...outflowWarnings, ...inferredOutflowWarnings];
  if (allOutflowWarnings.length) {
    safetyReasons.push("asset_outflow");
    warnings.push(...allOutflowWarnings);
  }

  const risk_level: PreparedTxRiskLevel = !sim.success
    ? "blocked"
    : safetyReasons.includes("abi_names_inferred")
      ? "high"
      : safetyReasons.length
        ? "medium"
        : "low";
  const signingRecommended = sim.success;

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
    human_summary: humanSummary(toFunctionSignature(fn), call.address, args, value),
    deeplink: signingRecommended ? deeplink(r.chainId, call.address, fn.name, call.args) : "",
    ...(signingRecommended ? { wallet_request: walletRequest(unsigned_tx) } : {}),
    warnings,
    safety: {
      signing_recommended: signingRecommended,
      risk_level,
      requires_human_confirmation: safetyReasons.length > 0,
      reasons: safetyReasons,
    },
  };
}
