/**
 * A split `grpcurl` command line to the fields of a unary gRPC request.
 *
 * The same two rules as `curl.ts` — an unrecognised flag warns rather than refuses (decision 4),
 * and every understood flag with nowhere to land is named with one clause of why (decision 13) —
 * over a different grammar: `grpcurl` is a Go program, so its flags take a single dash as
 * readily as two, and its positionals are an address followed by `pkg.Service/Method` rather
 * than a URL.
 *
 * What this module does *not* do is decide what a `-proto` is worth. That is
 * `api/import.ts`'s call, because answering it means reading the filesystem and composing
 * `planSpecs` (decision 26), and this file is grammar only.
 */
import { EXIT, PremanError } from "@preman/core/errors.js";
import { sanitiseSegment } from "@preman/core/workspace/paths.js";
import type { DroppedFlag } from "./plan.js";
import type { KeyValueEntry } from "./curl.js";

const DASH = "-";
const LONG_PREFIX = "--";
const EQUALS = "=";
const COLON = ":";
const AT = "@";
const PATH_SEPARATOR = "/";
const METHOD_SEPARATOR = ".";

/** The program names a pasted line may start with, however it was invoked. */
const GRPCURL_COMMANDS = new Set(["grpcurl", "grpcurl.exe"]);

/**
 * The subcommands that ask the server about itself.
 *
 * They produce a description, not a response, and a request file has no way to hold "tell me
 * what you serve". The Protos pane is where that question is asked here.
 */
const SUBCOMMANDS = new Set(["list", "describe"]);

/** Flags that consume the following word when it was not written `-flag=value`. */
const FLAGS_WITH_VALUE = new Set([
  "d",
  "H",
  "rpc-header",
  "reflect-header",
  "proto",
  "protoset",
  "protoset-out",
  "import-path",
  "cacert",
  "cert",
  "key",
  "authority",
  "servername",
  "max-time",
  "connect-timeout",
  "keepalive-time",
  "user-agent",
  "format",
  "max-msg-sz",
]);

/** The long name each of grpcurl's own short spellings means. */
const ALIASES: Record<string, string> = {
  d: "data",
  H: "header",
};

const TLS_REASON = "preman infers TLS from the target and layers certificates through --ssl-*";
const RUN_OPTION_REASON = "a preman run option, not a request field";
const OUTPUT_REASON = "output only";
const REFLECTION_REASON = "preman reads .proto files rather than server reflection";
const PROTOSET_REASON = "preman declares .proto sources; pass -proto instead";
const INCLUDE_REASON = "preman derives include dirs by climbing from the .proto to its checkout";
const NO_REPRESENTATION_REASON = "a request file has no field for it";
const STDIN_BODY_REASON = "reads the message from stdin";

/** Every flag that is understood and has nowhere to land, with the clause that says why. */
const DROP_REASONS: Record<string, string> = {
  plaintext: TLS_REASON,
  insecure: TLS_REASON,
  cacert: TLS_REASON,
  cert: TLS_REASON,
  key: TLS_REASON,
  authority: TLS_REASON,
  servername: TLS_REASON,
  "max-time": RUN_OPTION_REASON,
  "connect-timeout": RUN_OPTION_REASON,
  "keepalive-time": RUN_OPTION_REASON,
  v: OUTPUT_REASON,
  vv: OUTPUT_REASON,
  verbose: OUTPUT_REASON,
  "emit-defaults": OUTPUT_REASON,
  "format-error": OUTPUT_REASON,
  "msg-template": OUTPUT_REASON,
  format: OUTPUT_REASON,
  "reflect-header": REFLECTION_REASON,
  "use-reflection": REFLECTION_REASON,
  protoset: PROTOSET_REASON,
  "protoset-out": PROTOSET_REASON,
  "import-path": INCLUDE_REASON,
  unix: NO_REPRESENTATION_REASON,
  "user-agent": NO_REPRESENTATION_REASON,
  "max-msg-sz": NO_REPRESENTATION_REASON,
  "allow-unknown-fields": NO_REPRESENTATION_REASON,
  "expand-headers": NO_REPRESENTATION_REASON,
};

/** When the method name survives nothing `sanitiseSegment` allows, the request still needs one. */
const FALLBACK_NAME = "Imported request";

interface Flag {
  /** Canonical long name, without the leading dashes. */
  readonly name: string;
  /** As the user wrote it, so a message can be found in the paste. */
  readonly spelling: string;
  readonly value: string | undefined;
}

export interface ParsedGrpcurl {
  /** The `host:port` authority, verbatim; `resolveTarget` reads it the same way. */
  readonly url: string;
  /** `pkg.Service.Method`: grpcurl's slash is already a dot here (decision 28). */
  readonly methodPath: string;
  readonly message: string | undefined;
  readonly metadata: readonly KeyValueEntry[];
  /** The `-proto` paths as written, in order. Not a request field; see the module note. */
  readonly protos: readonly string[];
  readonly dropped: readonly DroppedFlag[];
  readonly warnings: readonly string[];
}

function usage(message: string, details: string[]): PremanError {
  return new PremanError(message, { exitCode: EXIT.CLI, details });
}

function requireValue(flag: Flag): string {
  if (flag.value === undefined) {
    throw usage(`${flag.spelling} needs a value`, ["the command ends before the value it expects"]);
  }
  return flag.value;
}

/**
 * The request name a method proposes: the method name on its own.
 *
 * `Echo` rather than `test.echo.EchoService.Echo`, because the package is already the
 * collection's business and both front ends let the name be edited before the write.
 */
export function nameForMethod(methodPath: string): string {
  const segments = methodPath.split(METHOD_SEPARATOR).filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  if (last !== undefined) {
    try {
      return sanitiseSegment(last);
    } catch {
      // Fall through to the constant rather than refuse an import over what to call it.
    }
  }
  return FALLBACK_NAME;
}

/** The words after the program name, if the paste led with one. */
function stripCommand(words: readonly string[]): readonly string[] {
  const first = words[0];
  if (first === undefined) return words;
  const program = first.split(PATH_SEPARATOR).pop() ?? first;
  return GRPCURL_COMMANDS.has(program.toLowerCase()) ? words.slice(1) : words;
}

/**
 * Words to flags and positionals.
 *
 * Go's `flag` package treats `-proto` and `--proto` as the same flag, so both spellings are
 * normalised to one name and only the spelling is kept for the message. An unrecognised flag
 * consumes nothing, for `curl.ts`'s reason: guessing that it takes the next word would swallow
 * the address of a command using a flag this table has never heard of.
 */
function tokenise(words: readonly string[]): { flags: Flag[]; positionals: string[] } {
  const flags: Flag[] = [];
  const positionals: string[] = [];
  let at = 0;

  while (at < words.length) {
    const word = words[at]!;
    at += 1;

    if (!word.startsWith(DASH) || word === DASH || word === LONG_PREFIX) {
      positionals.push(word);
      continue;
    }

    const dashes = word.startsWith(LONG_PREFIX) ? LONG_PREFIX.length : DASH.length;
    const rest = word.slice(dashes);
    const equals = rest.indexOf(EQUALS);
    const written = equals === -1 ? rest : rest.slice(0, equals);
    const inline = equals === -1 ? undefined : rest.slice(equals + 1);
    const takesValue = inline === undefined && FLAGS_WITH_VALUE.has(written);
    const value = takesValue ? words[at] : inline;
    if (takesValue) at += 1;
    flags.push({ name: ALIASES[written] ?? written, spelling: `${DASH}${written}`, value });
  }

  return { flags, positionals };
}

/** Everything the flags say, before any of it is turned into a request. */
interface GrpcurlState {
  message: string | undefined;
  readonly metadata: KeyValueEntry[];
  readonly protos: string[];
  readonly dropped: DroppedFlag[];
  readonly warnings: string[];
}

function drop(state: GrpcurlState, flag: Flag, reason: string): void {
  if (state.dropped.some((entry) => entry.flag === flag.spelling)) return;
  state.dropped.push({ flag: flag.spelling, reason });
}

/** `-H 'key: value'`, the same shape curl uses, because grpcurl chose the same spelling. */
function applyHeader(state: GrpcurlState, flag: Flag): void {
  const raw = requireValue(flag).trim();
  const colon = raw.indexOf(COLON);
  if (colon === -1) {
    state.warnings.push(`${flag.spelling} ${raw} names no value and was ignored`);
    return;
  }
  state.metadata.push({ key: raw.slice(0, colon).trim(), value: raw.slice(colon + 1).trim() });
}

function applyFlag(state: GrpcurlState, flag: Flag): void {
  switch (flag.name) {
    case "data": {
      const value = requireValue(flag);
      // `-d @` is grpcurl's "read the message from stdin". There is no stdin at send time, and
      // importing it as the literal `@` would write a request that fails on a malformed body.
      if (value.trim() === AT) {
        throw usage(`${flag.spelling} @ reads the message from stdin`, [
          STDIN_BODY_REASON,
          "paste the message text instead",
        ]);
      }
      state.message = value;
      return;
    }
    case "header":
    case "rpc-header":
      applyHeader(state, flag);
      return;
    case "proto":
      state.protos.push(requireValue(flag));
      return;
    default:
      break;
  }

  const reason = DROP_REASONS[flag.name];
  if (reason !== undefined) {
    // A dropped flag's value was already consumed by {@link tokenise}, which is what keeps
    // `-cacert /path` from leaving `/path` in the positionals to be read as the method. It is
    // still required here, so a command that ends mid-flag is refused rather than half-read.
    if (FLAGS_WITH_VALUE.has(flag.name)) requireValue(flag);
    drop(state, flag, reason);
    return;
  }
  state.warnings.push(`${flag.spelling} is not a flag preman knows; the request was imported without it`);
}

/**
 * The address and the method, out of grpcurl's two positionals.
 *
 * A third positional is grpcurl's symbol argument for `list` and `describe`, which are refused
 * above, so anything past the second is named and ignored rather than guessed at.
 */
function targetIn(positionals: readonly string[], warnings: string[]): { url: string; methodPath: string } {
  const [url, method, ...extra] = positionals;
  if (url === undefined || method === undefined) {
    throw usage("the command names no address and method", [
      ...positionals.map((word) => `  ${word}`),
      "grpcurl invokes a call as `grpcurl [flags] host:port pkg.Service/Method`",
    ]);
  }
  for (const word of extra) warnings.push(`"${word}" is not part of the request and was ignored`);

  const methodPath = method
    .split(PATH_SEPARATOR)
    .filter((part) => part.length > 0)
    .join(METHOD_SEPARATOR);
  if (!methodPath.includes(METHOD_SEPARATOR)) {
    throw usage(`"${method}" does not name a service and a method`, [
      "expected pkg.Service/Method, which preman holds as pkg.Service.Method",
    ]);
  }
  return { url, methodPath };
}

export function parseGrpcurl(words: readonly string[]): ParsedGrpcurl {
  const { flags, positionals } = tokenise(stripCommand(words));

  const subcommand = positionals.find((word) => SUBCOMMANDS.has(word));
  if (subcommand !== undefined) {
    throw usage(`\`${subcommand}\` asks the server what it serves; it is not a request`, [
      "import an invocation instead: grpcurl [flags] host:port pkg.Service/Method",
    ]);
  }

  const state: GrpcurlState = { message: undefined, metadata: [], protos: [], dropped: [], warnings: [] };
  for (const flag of flags) applyFlag(state, flag);

  const { url, methodPath } = targetIn(positionals, state.warnings);
  return {
    url,
    methodPath,
    message: state.message,
    metadata: state.metadata,
    protos: state.protos,
    dropped: state.dropped,
    warnings: state.warnings,
  };
}
