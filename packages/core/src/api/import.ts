/**
 * Importing a pasted `curl` or `grpcurl` command.
 *
 * The third way a workspace acquires a request, after `preman migrate` and the create dialog,
 * and the only one whose input was already on someone's clipboard.
 *
 * Split into {@link planImport} and {@link applyImportPlan} the way `planSpecs`/`applySpecPlan`
 * are (decision 5): the plan is a value, so `--dry-run` and the desktop's preview render the
 * same thing rather than running a second code path, and the plan is validated against the very
 * schema the runner will use (decision 6) so a preview cannot show a request the engine would
 * then refuse to load.
 */
import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { stringify } from "yaml";
import type { ZodType, ZodTypeDef } from "zod";
import { EXIT, PremanError } from "@preman/core/errors.js";
import { parseCurl, nameForUrl } from "@preman/core/import/curl.js";
import { parseGrpcurl, nameForMethod, type ParsedGrpcurl } from "@preman/core/import/grpcurl.js";
import { splitWords } from "@preman/core/import/shell.js";
import { CURL_FORMAT, GRPCURL_FORMAT, type CommandFormat } from "@preman/core/command/format.js";
import type { DroppedFlag, ImportPlan } from "@preman/core/import/plan.js";
import { GRPC_KEY_ORDER, HTTP_KEY_ORDER, YAML_OPTIONS, shape } from "@preman/core/postman/convert.js";
import { requestPathFor, REQUEST_SUFFIX } from "@preman/core/workspace/paths.js";
import {
  grpcRequestSchema,
  httpRequestSchema,
  type GrpcRequest,
  type HttpRequest,
} from "@preman/core/workspace/schemas.js";
import { applySpecPlan, planSpecs, type SpecPlan } from "@preman/core/api/specs.js";
import { writeRequestFile, type RequestKind } from "@preman/core/api/mutate.js";

const KIND_KEY = "$kind";
const NAME_KEY = "name";
const HTTP_KIND: RequestKind = "http-request";
const GRPC_KIND: RequestKind = "grpc-request";
const PATH_SEPARATOR = "/";
const EXE_SUFFIX = ".exe";
const FIRST = 0;
/** The only `schema.source` preman reads; the other one addresses Postman's servers (ADR 033). */
const FILE_SOURCE = "file";

/** The program names a paste may lead with, and the format each one means. */
const FORMAT_BY_COMMAND: Record<string, CommandFormat> = {
  curl: CURL_FORMAT,
  grpcurl: GRPCURL_FORMAT,
};

/** Shell words that end one command and begin another. */
const COMMAND_SEPARATORS = new Set([";", "&&", "||", "|", "&"]);

function usage(message: string, details: string[]): PremanError {
  return new PremanError(message, { exitCode: EXIT.CLI, details });
}

/** `curl`, `/usr/bin/curl` and `curl.exe` are the same program. */
function programOf(word: string): string {
  const last = word.split(PATH_SEPARATOR).pop() ?? word;
  const lower = last.toLowerCase();
  return lower.endsWith(EXE_SUFFIX) ? lower.slice(0, -EXE_SUFFIX.length) : lower;
}

/** The word lists between shell separators, empties removed. */
function segmentsOf(words: readonly string[]): string[][] {
  const segments: string[][] = [];
  let current: string[] = [];
  for (const word of words) {
    if (COMMAND_SEPARATORS.has(word)) {
      segments.push(current);
      current = [];
      continue;
    }
    current.push(word);
  }
  segments.push(current);
  return segments.filter((segment) => segment.length > 0);
}

/**
 * The one command in the paste.
 *
 * Two of them is a refusal naming the count (decision 29): `MutateResult` carries a single
 * `nodeId`, so a partial import is the only other answer and a partial import is worse than
 * none. A trailing `| jq` is not a second command; it is named and dropped.
 */
function commandIn(words: readonly string[], warnings: string[]): string[] {
  const segments = segmentsOf(words);
  if (segments.length === 0) throw usage("there is nothing to import", ["paste a curl or grpcurl command"]);

  const commands = segments.filter((segment) => FORMAT_BY_COMMAND[programOf(segment[0]!)] !== undefined);
  if (commands.length > 1) {
    throw usage(`the paste holds ${String(commands.length)} commands`, [
      ...commands.map((segment) => `  ${segment.join(" ")}`),
      "import them one at a time",
    ]);
  }

  const chosen = commands[0] ?? segments[0]!;
  for (const segment of segments) {
    if (segment === chosen) continue;
    warnings.push(`"${segment.join(" ")}" is not part of the request and was ignored`);
  }
  return chosen;
}

function sniffFormat(words: readonly string[], declared: CommandFormat | undefined): CommandFormat {
  if (declared !== undefined) return declared;
  const first = words[0];
  const format = first === undefined ? undefined : FORMAT_BY_COMMAND[programOf(first)];
  if (format !== undefined) return format;
  throw usage("the paste starts with neither curl nor grpcurl", [
    `first word: ${first ?? "(none)"}`,
    `say which it is with --format ${CURL_FORMAT} or --format ${GRPCURL_FORMAT}`,
  ]);
}

/**
 * A name no sibling in `parentDir` has taken.
 *
 * Resolved here rather than only at write time so the pane's editable field shows the name the
 * file will actually carry. `requestPathFor` resolves the same collision again on the way out,
 * which is a no-op once the name is already free.
 */
function freeName(parentDir: string | undefined, name: string): string {
  if (parentDir === undefined || !existsSync(parentDir)) return name;
  return basename(requestPathFor(parentDir, name)).slice(0, -REQUEST_SUFFIX.length);
}

/** Strip the keys a parsed command left `undefined`, so they do not reach the YAML as nulls. */
function compact(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
}

function documentFor(parsed: ReturnType<typeof parseCurl>, name: string): Record<string, unknown> {
  const body =
    parsed.body === undefined
      ? undefined
      : parsed.body.type === "formdata"
        ? { type: parsed.body.type, formdata: parsed.body.formdata.map((entry) => compact({ ...entry })) }
        : parsed.body.type === "urlencoded"
          ? { type: parsed.body.type, urlencoded: [...parsed.body.urlencoded] }
          : { type: parsed.body.type, content: parsed.body.content };

  return shape(
    compact({
      [KIND_KEY]: HTTP_KIND,
      [NAME_KEY]: name,
      method: parsed.method,
      url: parsed.url,
      headers: parsed.headers.length > 0 ? [...parsed.headers] : undefined,
      queryParams: parsed.queryParams.length > 0 ? [...parsed.queryParams] : undefined,
      body,
      auth: parsed.auth === undefined ? undefined : { type: parsed.auth.type, credentials: parsed.auth.credentials },
    }),
    HTTP_KEY_ORDER,
  ) as Record<string, unknown>;
}

/**
 * Refuse a document the runner's own reader would refuse, before anything is shown or written.
 *
 * `033`'s rule one step earlier: the migration validates on the way to a file, and an import
 * validates on the way to a preview, so the preview cannot promise a request that will not load.
 */
function validated<T>(document: Record<string, unknown>, schema: ZodType<T, ZodTypeDef, unknown>): T {
  const parsed = schema.safeParse(document);
  if (parsed.success) return parsed.data;
  throw usage("the command does not describe a request preman can hold", [
    ...parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    "this is a gap in the importer; the command itself may be fine",
  ]);
}

export interface PlanImportArgs {
  /** The workspace, for the `.proto` declarations a `grpcurl -proto` would also need. */
  readonly root: string;
  readonly text: string;
  /** Overrides the sniff. `undefined` reads the format off the first word (decision 1). */
  readonly format?: CommandFormat;
  /** The destination, when one is chosen already; used only to propose a free name. */
  readonly parentDir?: string;
}

/** Everything importing `text` would do, without doing any of it. */
export function planImport(args: PlanImportArgs): ImportPlan {
  if (args.text.trim().length === 0) {
    throw usage("there is nothing to import", ["paste a curl or grpcurl command"]);
  }

  const warnings: string[] = [];
  const words = commandIn(splitWords(args.text), warnings);
  const format = sniffFormat(words, args.format);
  if (format === GRPCURL_FORMAT) return planGrpcurl(args, words, warnings);

  const parsed = parseCurl(words);
  const name = freeName(args.parentDir, nameForUrl(parsed.url));
  const document = documentFor(parsed, name);
  return {
    format: CURL_FORMAT,
    kind: HTTP_KIND,
    name,
    request: validated<HttpRequest>(document, httpRequestSchema),
    contents: stringify(document, YAML_OPTIONS),
    dropped: parsed.dropped,
    warnings: [...warnings, ...parsed.warnings],
    specs: null,
  };
}

export interface ApplyImportArgs {
  readonly root: string;
  readonly parentDir: string;
  readonly plan: ImportPlan;
  /** Overrides the plan's proposal, which is what the pane's editable field sends. */
  readonly name?: string;
}

/**
 * Declare the plan's specs, then write its request file.
 *
 * Specs first: a request pointing at a `.proto` the workspace has not declared is a request
 * that fails at send, and the declaration is the half that can fail on a name conflict.
 */
export function applyImportPlan(args: ApplyImportArgs): { readonly file: string } {
  const { plan } = args;
  if (plan.specs !== null) applySpecPlan(args.root, plan.specs);
  const name = args.name ?? plan.name;
  return {
    file: writeRequestFile({
      parentDir: args.parentDir,
      name,
      contents: renamed(plan, name),
      kind: plan.kind,
    }),
  };
}

/** The plan's YAML with the caller's name in it, so the file and its `name` field agree. */
function renamed(plan: ImportPlan, name: string): string {
  if (name === plan.name) return plan.contents;
  return plan.contents.replace(NAME_LINE, () => `${NAME_KEY}: ${stringify(name, YAML_OPTIONS).trimEnd()}\n`);
}

/** The `name:` line the plan wrote; always present, always second, always at column zero. */
const NAME_LINE = new RegExp(`^${NAME_KEY}:.*\\n`, "m");

/** What a `-proto` is worth: a declaration to make, and the location the request will name. */
interface GrpcSchema {
  /** `null` when there is nothing on this machine to declare. */
  readonly plan: SpecPlan | null;
  /** What goes in `schema.location`, or `undefined` for no `schema` at all (decision 27). */
  readonly location: string | undefined;
}

/**
 * The three ways a `grpcurl` names its schema, and what each one costs.
 *
 * A `-proto` that is on this machine is planned through `planSpecs`, so one import stages the
 * shared link, the `resources.yaml` entry and the request together and the proto is load-checked
 * before anything is written (decision 26). A `-proto` that is not here is still written into
 * `schema.location` as it was given: the path is the only clue anyone has about which file to go
 * and get, and throwing it away would leave a request naming no schema at all.
 *
 * A `grpcurl` with no `-proto` used server reflection, which core does not have. The request is
 * imported anyway, in the words its send will fail with, because a correct address, methodPath
 * and message body are worth more than the one field that is missing.
 */
function schemaFor(root: string, parsed: ParsedGrpcurl, warnings: string[]): GrpcSchema {
  if (parsed.protos.length === 0) {
    warnings.push(
      `no .proto was named, so sending this will fail with "no declared spec defines ${parsed.methodPath}"`,
    );
    warnings.push("declare one in the Protos pane, or with `preman protos link <name> <checkout>`");
    return { plan: null, location: undefined };
  }

  // A relative `-proto` was relative to wherever grpcurl ran, which is not knowable from a
  // paste. The workspace root is the one directory both front ends agree on, so it is the
  // anchor; an absolute path, which is what a copied command usually carries, is untouched.
  const located = parsed.protos.map((proto) => ({ proto, path: isAbsolute(proto) ? proto : resolve(root, proto) }));
  const present = located.filter((entry) => existsSync(entry.path));
  for (const entry of located) {
    if (present.includes(entry)) continue;
    warnings.push(`${entry.proto} is not on this machine, so it is named but not declared`);
    warnings.push("point a link at its checkout with `preman protos link <name> <checkout>`");
  }
  if (present.length === 0) return { plan: null, location: parsed.protos[FIRST] };

  const plan = planSpecs(
    root,
    present.map((entry) => entry.path),
  );
  for (const entry of plan.entries) {
    if (entry.loadError !== undefined) warnings.push(`${entry.declared} does not load: ${entry.loadError}`);
  }
  for (const name of plan.conflicts) warnings.push(`the link "${name}" already points somewhere else`);
  return { plan, location: plan.entries[FIRST]?.declared ?? present[FIRST]!.path };
}

function grpcDocumentFor(parsed: ParsedGrpcurl, name: string, location: string | undefined): Record<string, unknown> {
  return shape(
    compact({
      [KIND_KEY]: GRPC_KIND,
      [NAME_KEY]: name,
      url: parsed.url,
      methodPath: parsed.methodPath,
      schema: location === undefined ? undefined : { source: FILE_SOURCE, location },
      message: parsed.message === undefined ? undefined : { content: parsed.message },
      metadata: parsed.metadata.length > 0 ? [...parsed.metadata] : undefined,
    }),
    GRPC_KEY_ORDER,
  ) as Record<string, unknown>;
}

function planGrpcurl(args: PlanImportArgs, words: readonly string[], warnings: readonly string[]): ImportPlan {
  const parsed = parseGrpcurl(words);
  const notes = [...warnings, ...parsed.warnings];
  const schema = schemaFor(args.root, parsed, notes);
  const name = freeName(args.parentDir, nameForMethod(parsed.methodPath));
  const document = grpcDocumentFor(parsed, name, schema.location);
  return {
    format: GRPCURL_FORMAT,
    kind: GRPC_KIND,
    name,
    request: validated<GrpcRequest>(document, grpcRequestSchema),
    contents: stringify(document, YAML_OPTIONS),
    dropped: parsed.dropped,
    warnings: notes,
    specs: schema.plan,
  };
}

export type { DroppedFlag, CommandFormat, ImportPlan };
