/**
 * Build script: bundles the CLI for node, keeping @grpc/* external because their
 * internals rely on dynamic requires / native bindings that do not bundle cleanly.
 */
import { chmod, readFile, writeFile } from "node:fs/promises";

const OUTFILE = "dist/preman.js";
const SHEBANG = "#!/usr/bin/env node\n";

const result = await Bun.build({
  entrypoints: ["src/cli.ts"],
  outdir: "dist",
  target: "node",
  format: "esm",
  naming: "preman.js",
  external: ["@grpc/grpc-js", "@grpc/proto-loader", "@inquirer/prompts"],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const code = await readFile(OUTFILE, "utf8");
if (!code.startsWith("#!")) await writeFile(OUTFILE, SHEBANG + code);
await chmod(OUTFILE, 0o755);

console.log(`built ${OUTFILE}`);
