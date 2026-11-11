/**
 * `bun run test:app:linux [paths] [vitest options] [--media[=scenes]]`
 *
 * Builds the box if its Dockerfile changed, runs the app suites inside it under Xvfb, and exits
 * with the suite's status. See `docs/plans/032` and `CONTRIBUTING.md`.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { boxCommand, parseBoxArguments } from "./command.js";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "../../..");
const COMPOSE_FILE = join(import.meta.dirname, "compose.yml");
const BUN_VERSION_FILE = join(REPOSITORY_ROOT, ".bun-version");
const SERVICE = "app";
const FAILED_TO_START = 1;

const run = parseBoxArguments(process.argv.slice(2));
const result = spawnSync(
  "docker",
  ["compose", "-f", COMPOSE_FILE, "run", "--rm", "--build", SERVICE, "bash", "-c", boxCommand(run)],
  {
    cwd: REPOSITORY_ROOT,
    stdio: "inherit",
    env: { ...process.env, BUN_VERSION: readFileSync(BUN_VERSION_FILE, "utf8").trim() },
  },
);
if (result.error !== undefined) {
  console.error(`Could not run docker: ${result.error.message}. Is Docker running?`);
  process.exit(FAILED_TO_START);
}
process.exit(result.status ?? FAILED_TO_START);
