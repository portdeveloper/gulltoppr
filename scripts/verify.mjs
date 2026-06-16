import { spawnSync } from "node:child_process";

// Runs every verification step regardless of failures, then prints a per-step
// summary. Exits non-zero if any step failed. Unlike a plain `&&` chain, a
// failure early on (e.g. audit) never hides a failure later (e.g. test:sdk).
const steps = [
  { name: "typecheck", cmd: "npm", args: ["run", "typecheck"] },
  { name: "test", cmd: "npm", args: ["test"] },
  { name: "audit", cmd: "npm", args: ["run", "audit"] },
  { name: "build:sdk", cmd: "npm", args: ["run", "build:sdk"] },
  { name: "test:sdk:dist", cmd: "npm", args: ["run", "test:sdk:dist"] },
  { name: "test:sdk", cmd: "npm", args: ["run", "test:sdk"] },
  { name: "audit:sdk", cmd: "npm", args: ["run", "audit:sdk"] },
];

const results = [];
for (const step of steps) {
  console.log(`\n─── ${step.name} ───`);
  const { status } = spawnSync(step.cmd, step.args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  results.push({ name: step.name, ok: status === 0 });
}

console.log("\n═══ verify summary ═══");
for (const { name, ok } of results) {
  console.log(`${ok ? "✓ pass" : "✗ FAIL"}  ${name}`);
}

const failed = results.filter((r) => !r.ok);
if (failed.length > 0) {
  console.log(`\n${failed.length}/${results.length} step(s) failed: ${failed.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
console.log(`\nall ${results.length} steps passed`);
