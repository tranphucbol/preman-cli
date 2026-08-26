import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { EXIT, PremanError } from "@preman/core/errors.js";
import { writeFileAtomic } from "@preman/core/workspace/atomic.js";
import { NO_PROGRESS } from "./progress.js";
import type { FilePlan } from "./plan.js";
import type { ProgressTracker } from "./progress.js";

/**
 * The one place a migration touches the disk.
 *
 * Separate from `convert.ts` so that `--dry-run` is the same conversion with this call
 * omitted, rather than a second path through the same logic (ADR 033).
 */

/** Plan paths are posix; `join` wants host segments. */
const PATH_SEPARATOR = "/";
/**
 * Files an operating system leaves in a directory a user merely looked at. Counting them as
 * content would make `Open Workspace…` on macOS pick a folder that can never be migrated into.
 */
const OS_BOOKKEEPING = new Set([".DS_Store", "Thumbs.db", ".localized"]);
/**
 * How many files pass between two progress reports.
 *
 * Writing is the one phase that knows its size before it starts, so it is the one phase a reader
 * can draw honestly from zero. Reporting each of 684 files would be 684 reports for a phase that
 * takes well under a second; reporting only at the end would draw a bar that jumps from empty to
 * full and says nothing.
 */
const PROGRESS_FILE_INTERVAL = 25;
const NOTHING = 0;

function occupants(target: string): string[] {
  if (!existsSync(target)) return [];
  return readdirSync(target).filter((entry) => !OS_BOOKKEEPING.has(entry));
}

/**
 * Write every planned file under `target`.
 *
 * Refuses a target that already holds anything: a migration is one-way and has no
 * merge semantics, so writing into occupied directory would leave a mixture no one authored. A
 * second migration goes to a new directory.
 *
 * Synchronous inside, per ADR 003, and `Promise`-returning because both front ends await it.
 */
export function applyPlan(target: string, plan: FilePlan, progress: ProgressTracker = NO_PROGRESS): Promise<void> {
  const existing = occupants(target);
  if (existing.length > 0) {
    throw new PremanError(`${target} is not empty`, {
      exitCode: EXIT.CLI,
      details: [
        `it already holds ${existing.length === 1 ? existing[0] : `${existing.length} entries`}`,
        "migration writes a new workspace; choose a directory that does not exist yet",
      ],
    });
  }

  const total = plan.files.length;
  progress.at("writing", NOTHING, total);
  let written = NOTHING;
  for (const file of plan.files) {
    // `writeFileAtomic` creates the parent, so the plan needs no directory entries of its own.
    writeFileAtomic(join(target, ...file.relativePath.split(PATH_SEPARATOR)), file.contents);
    written += 1;
    if (written % PROGRESS_FILE_INTERVAL === NOTHING) progress.at("writing", written, total);
  }
  // Always the last word, whatever the interval landed on: a bar left at 675 of 684 is a bar that
  // says the migration stopped short of finishing.
  progress.at("writing", written, total);
  return Promise.resolve();
}
