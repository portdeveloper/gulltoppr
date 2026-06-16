/**
 * Build the capability manifest (SPEC §2.4a) — "the buttons" a contract UI renders —
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
  if (token?.decimals === undefined) return undefined;
  if (!inputs.some(looksLikeAmount)) return undefined;
  const unit = 10n ** BigInt(token.decimals);
  return `amount is in base units (${token.decimals} decimals): 1 ${token.symbol ?? "token"} = "${unit.toString()}"`;
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

export type ContractMethodKind = "read" | "write" | "all";

export interface ContractMethodSearchOpts {
  q?: string;
  kind?: ContractMethodKind;
  limit?: number;
}

export type ContractMethodMatch =
  | { kind: "read"; method: ReadCapability }
  | { kind: "write"; method: WriteCapability };

function methodHaystack(method: ReadCapability | WriteCapability): string {
  const outputs = "outputs" in method ? method.outputs : [];
  return [
    method.function,
    method.signature,
    method.hint,
    ...method.inputs.flatMap((param) => [param.name, param.type]),
    ...outputs.flatMap((param) => [param.name, param.type]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function methodMatches(method: ReadCapability | WriteCapability, query: string): boolean {
  if (!query) return true;
  const haystack = methodHaystack(method);
  if (haystack.includes(query)) return true;
  if (haystack.replace(/\s+/g, "").includes(query.replace(/\s+/g, ""))) return true;
  return query.split(/\s+/).every((token) => haystack.includes(token));
}

export function searchContractMethods(
  contractInterface: ContractInterface,
  opts: ContractMethodSearchOpts = {},
): ContractMethodMatch[] {
  const query = opts.q?.trim().toLowerCase() ?? "";
  const kind = opts.kind ?? "all";
  const limit = opts.limit == null ? undefined : Math.max(0, Math.floor(opts.limit));
  const matches: ContractMethodMatch[] = [];

  if (kind === "all" || kind === "read") {
    for (const method of contractInterface.reads) {
      if (methodMatches(method, query)) matches.push({ kind: "read", method });
    }
  }
  if (kind === "all" || kind === "write") {
    for (const method of contractInterface.writes) {
      if (methodMatches(method, query)) matches.push({ kind: "write", method });
    }
  }
  return limit === undefined ? matches : matches.slice(0, limit);
}

export function filterContractInterface(
  contractInterface: ContractInterface,
  opts: ContractMethodSearchOpts = {},
): ContractInterface {
  const matches = searchContractMethods(contractInterface, opts);
  return {
    reads: matches.filter((match): match is { kind: "read"; method: ReadCapability } => match.kind === "read").map((match) => match.method),
    writes: matches.filter((match): match is { kind: "write"; method: WriteCapability } => match.kind === "write").map((match) => match.method),
  };
}
