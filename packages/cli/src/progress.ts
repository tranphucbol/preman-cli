import { renderProgress } from "@preman/cli/render/migrate.js";
import type { MigrationPhase, MigrationProgress, MigrationReporter } from "@preman/core";

/**
 * Where a long command says how far it has got.
 *
 * **Standard error, never standard output.** Standard output carries the report, and under `--json`
 * it carries a document; a bar redrawn into that is a document a pipe cannot parse. The precedent
 * is already here — `main.ts` puts its `warn:` lines on stderr for the same reason — and it is why
 * this takes the stream as an argument rather than reaching for one.
 *
 * Two behaviours, chosen by whether anyone is watching. A terminal gets one line rewritten in
 * place. Anything else — a pipe, a CI log, a file — gets one line per phase, because carriage
 * returns in a log file are just noise and a log wants to be able to say when each phase began.
 */

/** Erase the whole line, then return to its start. Every terminal that reports a TTY has this. */
const ERASE_LINE = "\u001B[2K\r";
/**
 * What to assume when a TTY does not say how wide it is.
 *
 * A pty with no window size attached reports `columns: 0` rather than leaving it undefined — `script
 * -q /dev/null` is one, and so is a terminal that has not answered yet. Zero is not a width, it is
 * a terminal declining to say, and reading it as one silently drops the bar.
 */
const ASSUMED_COLUMNS = 80;
/** Not a terminal, so `renderProgress` picks its narrow form and no bar is drawn. */
const NO_COLUMNS = 0;

/**
 * A stream this can draw on, described by what is used rather than by `NodeJS.WriteStream`, so a
 * test can pass an object and read back what was written.
 */
export interface ProgressStream {
  readonly isTTY: boolean;
  readonly columns?: number | undefined;
  write(chunk: string): unknown;
}

export interface ProgressWriter {
  /** Hand this to `onProgress`. */
  readonly report: MigrationReporter;
  /** Take the line back down, before whatever is printed next. Safe to call twice. */
  readonly clear: () => void;
}

export function progressWriter(stream: ProgressStream): ProgressWriter {
  let drawn = false;
  let announced: MigrationPhase | undefined;

  const live = (progress: MigrationProgress): void => {
    const columns = stream.columns;
    stream.write(
      `${ERASE_LINE}${renderProgress(progress, columns === undefined || columns <= NO_COLUMNS ? ASSUMED_COLUMNS : columns)}`,
    );
    drawn = true;
  };

  const logged = (progress: MigrationProgress): void => {
    if (progress.phase === announced) return;
    announced = progress.phase;
    stream.write(`${renderProgress(progress, NO_COLUMNS)}\n`);
  };

  return {
    report: (progress) => {
      if (stream.isTTY) live(progress);
      else logged(progress);
    },
    clear: () => {
      // Only a rewritten line needs taking down; a logged one is already history.
      if (!drawn) return;
      drawn = false;
      stream.write(ERASE_LINE);
    },
  };
}
