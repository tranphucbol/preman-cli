import { mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EXIT, PremanError } from "@preman/core/errors.js";

/**
 * Exported because it is part of how long a filename may be: the temp file is a sibling, so
 * every name preman writes has to fit inside the filesystem's limit *with this appended*.
 * `paths.ts` reserves it.
 */
export const TEMP_SUFFIX = ".preman-tmp";
const ENCODING = "utf8";

/**
 * Write `contents` to `file` so that a crash leaves either the old file or the new
 * one, never half of either.
 *
 * `rename` within a directory is atomic on every filesystem this runs on, so the
 * temp file is a sibling rather than in the system temp directory — a cross-device
 * rename would silently degrade to copy-then-delete and lose the guarantee.
 */
export function writeFileAtomic(file: string, contents: string): void {
  const temp = `${file}${TEMP_SUFFIX}`;
  try {
    // Inside the try: a parent that cannot be created is the same failure to a caller
    // as a write that could not land, and both owe it a PremanError with a cause.
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(temp, contents, ENCODING);
    renameSync(temp, file);
  } catch (cause) {
    // Best effort: the temp file is already the failure, so its removal must not mask it.
    try {
      unlinkSync(temp);
    } catch {
      /* the temp file was never created, or is not ours to remove */
    }
    throw new PremanError(`failed to write ${file}: ${(cause as Error).message}`, {
      exitCode: EXIT.CLI,
      details: ["the original file was left untouched"],
    });
  }
}
