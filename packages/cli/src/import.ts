import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXIT, PremanError } from "@preman/core/errors.js";
import { CURL_FORMAT, GRPCURL_FORMAT, type CommandFormat } from "@preman/core/command/format.js";
import { listGroups, listRequests, type RequestGroup } from "@preman/core/workspace/collections.js";
import { requireWorkspace } from "@preman/core/workspace/discover.js";

/**
 * The terminal's half of `preman import`: where the pasted text comes from, and where it lands.
 *
 * Both answers are the CLI's to give and neither belongs in the engine. `planImport` takes text
 * and a directory; a clipboard, a pipe and a `--into` selector are argv concerns, and the desktop
 * answers all three differently.
 */

/** `readFileSync` reads the pipe from the descriptor; there is no sync form of `process.stdin`. */
const STDIN = 0;
const PARENT = "..";
const PATH_SEPARATOR = "/";
const NONE = 0;
const FIRST = 0;
const SINGLE = 1;
const COLLECTION_KIND = "collection";

const FORMAT_NAMES: Readonly<Record<string, CommandFormat>> = {
  [CURL_FORMAT]: CURL_FORMAT,
  [GRPCURL_FORMAT]: GRPCURL_FORMAT,
};

/**
 * Words that survive `splitWords` unquoted.
 *
 * Deliberately conservative: anything outside this set is single-quoted on the way back into one
 * string, because the fence hands back `["-H", "a: b"]` as separate argv slots and joining them
 * with a space would let the splitter re-split the header value into two words.
 */
const BARE_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/;
const SINGLE_QUOTE = "'";
/** Close the quote, escape the apostrophe, reopen — the only way to put a `'` inside `'…'`. */
const ESCAPED_QUOTE = "'\\''";

/**
 * `main` raises this too, from the one place a paste can fail before `pastedText` is ever called:
 * `parseArgs` rejects an unknown `-X` outright, and its own advice does not mention `import`.
 */
export const FENCE_MESSAGE = "put the pasted command after a `--` fence";
export const FENCE_DETAILS = [
  "preman owns -d, -e, -k, -n, -r and -v, and curl spells all six differently",
  "example: preman import curl --into acme -- curl -k -H 'accept: application/json' https://api.test/orders",
];

function usage(message: string, details: string[]): PremanError {
  return new PremanError(message, { exitCode: EXIT.CLI, details });
}

/** The declared format, refusing a name neither parser answers to. */
export function importFormat(raw: string | undefined): CommandFormat | undefined {
  if (raw === undefined) return undefined;
  const format = FORMAT_NAMES[raw.trim().toLowerCase()];
  if (format === undefined) {
    throw usage(`unknown import format "${raw}"`, [`expected ${CURL_FORMAT} or ${GRPCURL_FORMAT}`]);
  }
  return format;
}

/** Whether a positional is the optional format word rather than the start of the paste. */
export function isImportFormat(word: string): boolean {
  return FORMAT_NAMES[word] !== undefined;
}

function quoted(word: string): string {
  if (BARE_WORD.test(word)) return word;
  return `${SINGLE_QUOTE}${word.split(SINGLE_QUOTE).join(ESCAPED_QUOTE)}${SINGLE_QUOTE}`;
}

export interface PastedTextArgs {
  /** `--from <file>`, which wins over everything: it is the only unambiguous source. */
  readonly from: string | undefined;
  /** The positionals left after the command and the optional format word. */
  readonly words: readonly string[];
  /** Whether argv held a `--`. Without it those words already lost curl's short flags. */
  readonly fenced: boolean;
}

/**
 * The text to import: `--from`, then fenced positionals, then stdin.
 *
 * Stdin is the default because the input is a clipboard and a multi-line curl does not survive
 * hand-quoting into one argv slot. Positionals without a fence are refused rather than imported:
 * `parseArgs` runs over all of argv in one call, so `-k` in an unfenced paste becomes preman's
 * own `--insecure` and vanishes from the positionals with no error at all. Importing what is
 * left would silently drop flags the paste was explicit about.
 */
export function pastedText(args: PastedTextArgs): string {
  if (args.from !== undefined) {
    try {
      return readFileSync(args.from, "utf8");
    } catch (cause) {
      throw usage(`could not read "${args.from}"`, [(cause as Error).message]);
    }
  }

  if (args.words.length > NONE) {
    if (!args.fenced) throw usage(FENCE_MESSAGE, FENCE_DETAILS);
    return args.words.map(quoted).join(" ");
  }

  if (process.stdin.isTTY === true) {
    throw usage("there is nothing to import", [
      "pipe the command in, or pass --from <file>, or fence it: preman import -- curl …",
    ]);
  }
  return readFileSync(STDIN, "utf8");
}

export interface ImportDestination {
  readonly root: string;
  /** The group's display path, e.g. `acme` or `acme/orders`. */
  readonly path: string;
  /** The directory the request file goes in. */
  readonly dir: string;
}

/**
 * The directory a group occupies.
 *
 * Climbed from a request rather than joined from the root, because a group's `path` carries its
 * *display* name and `sanitiseSegment` makes no promise that it matches the directory on disk.
 */
function directoryOf(group: RequestGroup): string {
  const entry = group.requests[FIRST]!;
  const depth = entry.ancestors.findIndex((ancestor) => ancestor.path === group.path);
  const climb = entry.ancestors.length - SINGLE - depth;
  return join(dirname(entry.filePath), ...new Array<string>(climb).fill(PARENT));
}

/**
 * Where the imported request goes.
 *
 * `--into` resolves through `listGroups` so a folder is as valid a destination as a collection.
 * Omitted with exactly one collection adopts it, which is the single-collection workspace this
 * is most often run in; omitted with several is an error listing them, because guessing which
 * collection someone's clipboard belongs to is the one thing an importer must never do.
 */
export function resolveDestination(dir: string, into: string | undefined): ImportDestination {
  const ws = requireWorkspace(dir);
  const groups = listGroups(listRequests(ws));
  if (groups.length === NONE) {
    throw usage("this workspace has no collection to import into", [
      "a collection is a directory under postman/collections holding at least one request",
    ]);
  }

  const chosen = into === undefined ? onlyCollection(groups) : matching(groups, into);
  return { root: ws.root, path: chosen.path, dir: directoryOf(chosen) };
}

function onlyCollection(groups: readonly RequestGroup[]): RequestGroup {
  const collections = groups.filter((group) => group.kind === COLLECTION_KIND);
  if (collections.length === SINGLE) return collections[FIRST]!;
  throw usage("say which collection to import into with --into <name>", [
    ...collections.map((group) => `  ${group.path}`),
    "a folder works too: --into acme/orders",
  ]);
}

function matching(groups: readonly RequestGroup[], into: string): RequestGroup {
  const needle = into.trim().toLowerCase();
  const tiers: Array<(group: RequestGroup) => boolean> = [
    (group) => group.path.toLowerCase() === needle,
    (group) => group.name.toLowerCase() === needle,
    (group) => group.path.toLowerCase().endsWith(`${PATH_SEPARATOR}${needle}`),
  ];

  for (const predicate of tiers) {
    const hits = groups.filter(predicate);
    if (hits.length === SINGLE) return hits[FIRST]!;
    if (hits.length > SINGLE) {
      throw usage(`"${into}" matches ${String(hits.length)} groups`, [
        ...hits.map((group) => `  ${group.path}`),
        "name one of them exactly",
      ]);
    }
  }

  throw usage(`no collection or folder matches "${into}"`, [
    ...groups.map((group) => `  ${group.path}`),
    "run `preman list` to see the workspace",
  ]);
}
