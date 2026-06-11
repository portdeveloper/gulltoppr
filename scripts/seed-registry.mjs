#!/usr/bin/env node
/**
 * Registry seeding sweep: find the most-called contracts on each chain (recent
 * blocks via public RPCs) and resolve them through the LIVE engine. Every
 * verified hit harvests selector→signature pairs into the commons; every
 * unverified one exercises the decompile path (and, with ANTHROPIC_API_KEY set
 * on the engine, the propose-and-verify pass).
 *
 * Paced to stay under the engine's 120 req/min/IP rate limit.
 *
 *   node scripts/seed-registry.mjs [perChain=120]
 */
const ENGINE = "https://gulltoppr.fly.dev";
const PER_CHAIN = Number(process.argv[2]) || 120;
const BLOCKS = { ethereum: 40, base: 120, optimism: 120, arbitrum: 240, polygon: 120 };
const RPCS = {
  ethereum: "https://ethereum-rpc.publicnode.com",
  base: "https://base-rpc.publicnode.com",
  optimism: "https://optimism-rpc.publicnode.com",
  arbitrum: "https://arbitrum-one-rpc.publicnode.com",
  polygon: "https://polygon-bor-rpc.publicnode.com",
};

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

/** Most-called `to` addresses over the last N blocks. */
async function topContracts(chain) {
  const url = RPCS[chain];
  const latest = parseInt(await rpc(url, "eth_blockNumber", []), 16);
  const counts = new Map();
  let scanned = 0;
  // sample every other block to halve RPC load on fast chains
  for (let n = latest; n > latest - BLOCKS[chain] && scanned < BLOCKS[chain] / 2 + 20; n -= 2) {
    try {
      const block = await rpc(url, "eth_getBlockByNumber", ["0x" + n.toString(16), true]);
      if (!block?.transactions) continue;
      scanned++;
      for (const tx of block.transactions) {
        if (tx.to) counts.set(tx.to, (counts.get(tx.to) || 0) + 1);
      }
    } catch { /* skip bad block fetch */ }
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, PER_CHAIN * 2)
    .map(([addr, n]) => ({ addr, n }));
  // drop EOAs (plain transfers) — they'd just burn an engine call on ABI_NOT_FOUND
  const contracts = [];
  for (const c of top) {
    if (contracts.length >= PER_CHAIN) break;
    try {
      const code = await rpc(url, "eth_getCode", [c.addr, "latest"]);
      if (code && code !== "0x") contracts.push(c);
    } catch { /* keep it; the engine will decide */ contracts.push(c); }
  }
  return contracts;
}

async function stats() {
  try {
    const r = await fetch(`${ENGINE}/v1/registry/stats`, { signal: AbortSignal.timeout(15000) });
    return await r.json();
  } catch { return null; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("BEFORE:", JSON.stringify(await stats()));
const tally = {};
let done = 0, total = 0;

for (const chain of Object.keys(RPCS)) {
  let list;
  try {
    list = await topContracts(chain);
  } catch (e) {
    console.log(`${chain}: block scan failed (${e.message}) — skipping chain`);
    continue;
  }
  console.log(`${chain}: ${list.length} candidates (top called ${list[0]?.n ?? 0}x)`);
  total += list.length;
  for (const { addr } of list) {
    const t0 = Date.now();
    let label;
    try {
      const r = await fetch(`${ENGINE}/v1/${chain}/${addr}/abi`, { signal: AbortSignal.timeout(120000) });
      if (r.status === 429) { label = "RATE_LIMITED"; await sleep(20000); }
      else {
        const d = await r.json();
        label = r.ok ? `${d.provenance.source}/${d.provenance.confidence}${d.cached ? " (cached)" : ""}` : (d.error?.code || `HTTP_${r.status}`);
      }
    } catch (e) {
      label = "FETCH_FAIL";
    }
    tally[label] = (tally[label] || 0) + 1;
    done++;
    if (done % 25 === 0) console.log(`[${done}/${total}] ${JSON.stringify(tally)}`);
    // pace: stay well under 120/min even when everything is a fast cache hit
    const elapsed = Date.now() - t0;
    if (elapsed < 700) await sleep(700 - elapsed);
  }
}

console.log("FINAL TALLY:", JSON.stringify(tally, null, 1));
console.log("AFTER:", JSON.stringify(await stats()));
