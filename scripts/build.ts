/**
 * Build script: bundles the CLI for node while keeping runtime packages external.
 */
import { chmod, readFile, writeFile } from "node:fs/promises";
import { SANDBOX_ALIASES, SANDBOX_PACKAGES } from "../src/scripts/modules.js";

const OUTFILE = "dist/preman.js";
const SHEBANG = "#!/usr/bin/env node\n";

/** Packages resolved from node_modules at runtime rather than inlined into dist/preman.js. */
const EXTERNAL_PACKAGES = [
  "@grpc/grpc-js",
  "@grpc/proto-loader",
  "@inquirer/prompts",
  ...SANDBOX_PACKAGES,
  ...Object.values(SANDBOX_ALIASES),
];

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  naming: "preman.js",
  external: EXTERNAL_PACKAGES,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const code = await readFile(OUTFILE, "utf8");
if (!code.startsWith("#!")) await writeFile(OUTFILE, SHEBANG + code);
await chmod(OUTFILE, 0o755);

console.log(`built ${OUTFILE}`);
