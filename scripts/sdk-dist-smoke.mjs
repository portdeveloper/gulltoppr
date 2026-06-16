import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sdk = await import(pathToFileURL(new URL("../sdk/dist/index.js", import.meta.url).pathname));
for (const name of ["Gulltoppr", "AbiNinja", "Contract", "ENGINE_ERROR_CODES", "filterContractInterface", "hasBytecodeMatch", "isHighFrictionProvenance", "isLowRiskPreparedTx", "provenanceWarnings", "requireLowRiskWalletRequest", "requireWalletRequest", "searchContractMethods", "AbiNinjaError"]) {
  assert(name in sdk, `dist export missing: ${name}`);
}

const dts =
  readFileSync(new URL("../sdk/dist/index.d.ts", import.meta.url), "utf8") +
  "\n" +
  readFileSync(new URL("../sdk/dist/types.d.ts", import.meta.url), "utf8");
for (const name of ["ResolveAbiOpts", "SimulateArgs", "ContractMethodSearchOpts", "ContractMethodMatch", "ProvenanceWarningInput", "EngineErrorCode", "BytecodeMatchProvenance", "DecodeTxProvenance", "DecodedCall", "DecodedCallArg", "CompactAbiResult", "PreparedTx", "WalletRequest"]) {
  assert(dts.includes(name), `dist types missing: ${name}`);
}

const packJson = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: new URL("../sdk", import.meta.url),
  encoding: "utf8",
});
const [pack] = JSON.parse(packJson);
const files = new Set(pack.files.map((file) => file.path));
const allowedFiles = new Set([
  "package.json",
  "README.md",
  "dist/client.d.ts",
  "dist/client.js",
  "dist/errors.d.ts",
  "dist/errors.js",
  "dist/index.d.ts",
  "dist/index.js",
  "dist/types.d.ts",
  "dist/types.js",
]);

for (const path of ["package.json", "README.md", "dist/index.js", "dist/index.d.ts", "dist/client.js", "dist/types.d.ts"]) {
  assert(files.has(path), `npm pack missing ${path}`);
}

for (const path of files) {
  assert(allowedFiles.has(path), `npm pack includes unexpected file ${path}`);
  assert(!path.startsWith("src/"), `npm pack should not include source file ${path}`);
  assert(!path.startsWith("test/"), `npm pack should not include test file ${path}`);
  assert(!path.endsWith(".map"), `npm pack should not include source map ${path}`);
}

assert(files.size === allowedFiles.size, `npm pack file count changed: expected ${allowedFiles.size}, got ${files.size}`);
assert(pack.size <= 15_000, `npm pack tarball too large: ${pack.size} bytes`);
assert(pack.unpackedSize <= 45_000, `npm pack unpacked size too large: ${pack.unpackedSize} bytes`);
assert(pack.bundled.length === 0, "npm pack should not bundle dependencies");

console.log(
  `[sdk-dist-smoke] ${pack.name}@${pack.version} exports and pack contents OK (${files.size} files, ${pack.size} bytes packed)`,
);
