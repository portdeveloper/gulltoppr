#!/usr/bin/env node
/**
 * Generate the hero-demo asciinema cast (assets/demo.cast) — an agent resolving
 * a LIVE unverified contract through the gulltoppr MCP. Every output line below
 * is from a real session against mcp.gulltoppr.dev (contract 0xBdb3…47B6,
 * an unverified MEV bot that traded in block 25294776); only pacing is staged.
 * Render: agg --font-size 16 assets/demo.cast assets/demo.gif
 */
import { writeFileSync } from "node:fs";

const W = 88, H = 30;
const ev = [];
let t = 0.4;

// ANSI palette
const R = "[0m";
const dim = (s) => `[2m${s}${R}`;
const gray = (s) => `[38;5;245m${s}${R}`;
const green = (s) => `[38;5;115m${s}${R}`;
const gold = (s) => `[38;5;221m${s}${R}`;
const blue = (s) => `[38;5;111m${s}${R}`;
const red = (s) => `[38;5;210m${s}${R}`;
const bold = (s) => `[1m${s}${R}`;

function out(s, dt = 0.0) { t += dt; ev.push([t, "o", s]); }
function line(s = "", dt = 0.06) { out(s + "\r\n", dt); }
function type(s, cps = 0.024) { for (const ch of s) out(ch, cps + Math.random() * 0.02); }
function pause(dt) { t += dt; }

// ── scene 1: the setup ────────────────────────────────────────────────
line(gray("# Ethereum block 25294776 — mined 30 seconds ago."), 0.2);
line(gray("# A contract just traded twice: ") + bold("0xBdb3ba9ffe392549E1f8658DD2630c141fDF47B6"));
pause(0.9);
line(gray("# Etherscan: ") + red('"Contract source code not verified"') + gray(" — no ABI, no names."));
line(gray("# 4byte/openchain: nothing. Your agent is blind… unless:"));
pause(1.2);
line();

// ── scene 2: the agent asks ───────────────────────────────────────────
out(green("❯ ") );
type("agent: what can this contract do?");
pause(0.8);
line();
line();

// tool call 1
line(blue("⏺ gulltoppr") + dim(" · resolve_abi(ethereum, 0xBdb3…47B6)"), 0.3);
pause(1.6); // decompile time
line(gold("  ⚠ DECOMPILED ABI") + dim(" — function/param names are inferred; verify intent before acting."));
line(dim("     source: ") + "heimdall-decompiled" + dim("  ·  27 functions recovered from raw bytecode"));
line(dim("     ") + green("1 name recovered from the registry (signature-proven)"));
pause(0.7);
line();
line(bold("  reads") + "   getImplementation() → uint256");
line("          Unresolved_800a35d9(uint256,address)", 0.12);
line(bold("  writes") + "  " + gold("pancakeV3SwapCallback(int256,int256,bytes)"));
line("          Unresolved_1f000000(address,uint256,uint256,uint256,address,…)  " + dim("payable"), 0.12);
line("          Unresolved_3c000000(address,address,uint256,address,uint256)  " + dim("payable"), 0.12);
line(dim("          … 22 more"), 0.12);
pause(1.0);
line();
line(green("✦") + " V3 swap callbacks + packed payable entrypoints → this is a " + bold("MEV/arbitrage bot") + ".");
pause(1.4);
line();

// tool call 2
line(blue("⏺ gulltoppr") + dim(" · read_contract(getImplementation)"), 0.3);
pause(0.9);
line("  → " + bold('"0"') + dim('  (raw 0x0000…0000)'));
pause(1.0);
line();

// ── scene 3: the point ────────────────────────────────────────────────
line(green("✦") + " Unverified bytecode → full interface + live reads, in two tool calls.");
pause(0.5);
line(dim("  Etherscan ABI: ") + red("✗") + dim("   4byte: ") + red("✗") + dim("   ") + bold("🐴 gulltoppr: ") + green("✓"));
pause(0.8);
line();
line(dim('  { "mcpServers": { "gulltoppr": { "url": "https://mcp.gulltoppr.dev/mcp" } } }'));
pause(3.5);

const header = { version: 2, width: W, height: H, title: "gulltoppr — resolve an unverified contract", env: { TERM: "xterm-256color" } };
writeFileSync("assets/demo.cast", JSON.stringify(header) + "\n" + ev.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log("wrote assets/demo.cast", ev.length, "events,", t.toFixed(1) + "s");
