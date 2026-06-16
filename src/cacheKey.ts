import { createHash } from "node:crypto";

export function chainRpcCacheScope(chainId: number, rpcUrl: string): string {
  const rpcHash = createHash("sha256").update(rpcUrl).digest("hex").slice(0, 16);
  return `${chainId}:${rpcHash}`;
}
