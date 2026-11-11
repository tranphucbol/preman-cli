/**
 * What the Linux box is asked to run, from the arguments `bun run test:app:linux` was given.
 * Pure, so the quoting is tested without a Docker daemon.
 */

/** Vitest reads a path as a substring filter, so the slash keeps `test/app-box.test.ts` out. */
export const APP_SUITE = "test/app/";
export const MEDIA_SUITE = "test/app/media/";
/** `--media` records every scene; `--media=send,palette` records those. */
const MEDIA_FLAG = "--media";
const MEDIA_ALL = "1";
const OPTION_PREFIX = "-";
const BUILD_DESKTOP = "bun run --filter '@preman/desktop' build";
/** One window at a time: the box has one display, and two launches would fight over its focus. */
const SERIAL = "--no-file-parallelism";

export interface BoxRun {
  /** `PREMAN_README_MEDIA`'s value, or `null` for the smoke suite. */
  media: string | null;
  tests: string[];
  options: string[];
}

export function parseBoxArguments(argv: readonly string[]): BoxRun {
  let media: string | null = null;
  const tests: string[] = [];
  const options: string[] = [];
  for (const argument of argv) {
    if (argument === MEDIA_FLAG) media = MEDIA_ALL;
    else if (argument.startsWith(`${MEDIA_FLAG}=`)) media = argument.slice(MEDIA_FLAG.length + 1) || MEDIA_ALL;
    // Everything from the first option on is Vitest's, values included: `-t palette` is one option.
    else if (options.length > 0 || argument.startsWith(OPTION_PREFIX)) options.push(argument);
    else tests.push(argument);
  }
  if (tests.length === 0) tests.push(media === null ? APP_SUITE : MEDIA_SUITE);
  return { media, tests, options };
}

/** One `bash -c` line: build the bundle the suite launches, then run it under the gates it needs. */
export function boxCommand(run: BoxRun): string {
  const gates = ["PREMAN_APP=1", ...(run.media === null ? [] : [`PREMAN_README_MEDIA=${shellQuote(run.media)}`])];
  const vitest = ["bunx", "vitest", "run", ...run.tests.map(shellQuote), SERIAL, ...run.options.map(shellQuote)];
  return `${BUILD_DESKTOP} && ${gates.join(" ")} ${vitest.join(" ")}`;
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
