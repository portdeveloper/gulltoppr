/**
 * Bytecode normalization for the registry (the ABI/selector commons).
 *
 * Two contracts compiled from the same source differ only in the solc CBOR
 * metadata trailer (ipfs/swarm hash of the *source*), so hashing raw runtime
 * bytecode misses near-all clones. We hash a normalized "skeleton" instead:
 * runtime bytecode with the metadata trailer(s) stripped. This is the same
 * trick behind Sourcify's "partial match".
 *
 * KNOWN LIMITATION (v1): `immutable` values are embedded in runtime code at
 * construction, so factory-deployed siblings that differ only in immutables
 * still hash differently. Masking them needs immutable-reference offsets we
 * don't have without source. EIP-1167 minimal proxies — the dominant clone
 * pattern — are already collapsed earlier by proxy detection.
 */
import { keccak256, type Hex } from "viem";

/** Known CBOR map keys solc (and vyper) put in the metadata trailer. */
const METADATA_KEYS = ["ipfs", "bzzr0", "bzzr1", "solc", "experimental", "vyper"];

/**
 * Strip the trailing CBOR metadata blob(s) from runtime bytecode.
 * Layout: ...code... <cbor blob> <2-byte big-endian length of blob>.
 * Loops because a handful of contracts concatenate more than one trailer.
 */
export function stripCborMetadata(code: Hex): Hex {
  let hex = code.toLowerCase().replace(/^0x/, "");
  for (let pass = 0; pass < 4; pass++) {
    if (hex.length < 4) break;
    const len = parseInt(hex.slice(-4), 16);
    if (!Number.isFinite(len) || len === 0) break;
    const blobChars = len * 2;
    if (blobChars + 4 > hex.length) break;
    const blob = hex.slice(hex.length - 4 - blobChars, hex.length - 4);
    if (!looksLikeMetadataCbor(blob)) break;
    hex = hex.slice(0, hex.length - 4 - blobChars);
  }
  return ("0x" + hex) as Hex;
}

/** Cheap structural check: starts like a small CBOR map and names a known key. */
function looksLikeMetadataCbor(blobHex: string): boolean {
  const first = parseInt(blobHex.slice(0, 2), 16);
  // 0xa1..0xa4 — CBOR map with 1–4 entries (solc emits 1–3).
  if (first < 0xa1 || first > 0xa4) return false;
  const ascii = blobHex.replace(/../g, (b) => {
    const c = parseInt(b, 16);
    return c >= 0x20 && c <= 0x7e ? String.fromCharCode(c) : ".";
  });
  return METADATA_KEYS.some((k) => ascii.includes(k));
}

/** The registry key: keccak256 of metadata-stripped runtime bytecode. */
export function skeletonHash(code: Hex): Hex {
  return keccak256(stripCborMetadata(code));
}
