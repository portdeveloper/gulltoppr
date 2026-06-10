/**
 * Build the capability manifest (SPEC §2.4a) — "the buttons abi.ninja renders" —
 * from a raw ABI. This is the headline product per SPEC §0.5: a normalized,
 * provenance-tagged, read/write-split view an agent reasons over.
 */
import { toFunctionSignature, type Abi, type AbiFunction } from "viem";
import type {
  ContractInterface,
  IoParam,
  Provenance,
  ReadCapability,
  TokenMeta,
  WriteCapability,
} from "../types.js";

export function abiFunctions(abi: Abi): AbiFunction[] {
  return abi.filter((i): i is AbiFunction => i.type === "function");
}

function params(items: readonly { name?: string; type: string }[] | undefined): IoParam[] {
  return (items ?? []).map((p) => ({ name: p.name ?? "", type: p.type }));
}

/** Heuristic: does a uint param look like a token amount we can hint decimals for? */
function looksLikeAmount(p: IoParam): boolean {
  if (!/^uint/.test(p.type)) return false;
  return /amount|value|wad|tokens|qty|quantity/i.test(p.name);
}

function amountHint(inputs: IoParam[], token?: TokenMeta): string | undefined {
  if (!token?.decimals) return undefined;
  if (!inputs.some(looksLikeAmount)) return undefined;
  const unit = 10 ** token.decimals;
  return `amount is in base units (${token.decimals} decimals): 1 ${token.symbol ?? "token"} = "${unit.toLocaleString("en-US", { useGrouping: false })}"`;
}

/**
 * Split functions into reads (view/pure) and writes (mutating), annotating each
 * with provenance-derived `names_synthetic` and best-effort hints.
 */
export function buildInterface(
  abi: Abi,
  provenance: Provenance,
  token?: TokenMeta,
): ContractInterface {
  const synthetic = provenance.names_synthetic;
  const reads: ReadCapability[] = [];
  const writes: WriteCapability[] = [];

  for (const fn of abiFunctions(abi)) {
    const inputs = params(fn.inputs);
    let signature: string;
    try {
      signature = toFunctionSignature(fn);
    } catch {
      signature = `${fn.name}(${inputs.map((i) => i.type).join(",")})`;
    }

    if (fn.stateMutability === "view" || fn.stateMutability === "pure") {
      reads.push({
        function: fn.name,
        signature,
        inputs,
        outputs: params(fn.outputs),
        names_synthetic: synthetic,
        ...(amountHint(inputs, token) ? { hint: amountHint(inputs, token) } : {}),
      });
    } else {
      writes.push({
        function: fn.name,
        signature,
        inputs,
        payable: fn.stateMutability === "payable",
        names_synthetic: synthetic,
        ...(amountHint(inputs, token) ? { hint: amountHint(inputs, token) } : {}),
      });
    }
  }

  return { reads, writes };
}
