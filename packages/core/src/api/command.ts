/**
 * Copying a request back out as a `curl` or `grpcurl` command.
 *
 * The reverse of `api/import.ts`, and the same shape: a plan is a value (decision 5), so the
 * CLI's stdout and the desktop's preview render one thing rather than running two code paths.
 *
 * It resolves and it stops. **Scripts are not run** (decision 6): a pre-request script can call
 * `pm.environment.set` and `pm.sendRequest`, and a copy gesture that writes the environment file
 * and makes HTTP calls is not a copy gesture. The cost is stated rather than hidden — a request
 * whose script signs a header copies to a command that gets a 401, and the `unexpressed` entry
 * for that script is the only thing standing between the user and a confusing ten minutes
 * (decision 8).
 */
import { CURL_FORMAT, GRPCURL_FORMAT } from "@preman/core/command/format.js";
import { renderCurl, type CurlBody, type CurlFormEntry } from "@preman/core/command/curl.js";
import { renderGrpcurl } from "@preman/core/command/grpcurl.js";
import {
  AUTH_SCOPE,
  NO_CERTS,
  type CommandCerts,
  type CommandPlan,
  type Revealed,
  type Unexpressed,
} from "@preman/core/command/plan.js";
import { quoteWords } from "@preman/core/command/shell.js";
import { resolveGrpcCall } from "@preman/core/grpc/call.js";
import { FILE_MODE, FORM_DATA_MODE } from "@preman/core/http/body.js";
import { buildHttpRequest } from "@preman/core/http/request.js";
import { renderAuth } from "@preman/core/auth/credentials.js";
import { normalizeProperties } from "@preman/core/http/headers.js";
import { resolveScriptChain, type Protocol } from "@preman/core/scripts/chain.js";
import { EXIT, PremanError } from "@preman/core/errors.js";
import { resolveTlsCerts, type TlsCertInput, type TlsCertOptions } from "@preman/core/tls/certs.js";
import { isDynamicVariable } from "@preman/core/vars/dynamic/index.js";
import { interpolateStrict, TOKEN_SOURCE } from "@preman/core/vars/interpolate.js";
import { SCOPES, VariableStore, type Scope } from "@preman/core/vars/store.js";
import { listRequests, type RequestEntry } from "@preman/core/workspace/collections.js";
import { loadPremanConfig } from "@preman/core/workspace/config.js";
import { requireWorkspace } from "@preman/core/workspace/discover.js";
import { loadGlobals } from "@preman/core/workspace/environments.js";
import { fileReader, type FileReader } from "@preman/core/workspace/files.js";
import { resolveAuth, type ResolvedAuth } from "@preman/core/workspace/inherit.js";
import { parseRequestDocument, parseRequestFile } from "@preman/core/workspace/request-file.js";
import { loadResources } from "@preman/core/workspace/resources.js";
import type { HttpRequest, RequestScript } from "@preman/core/workspace/schemas.js";
import type { RequestKind } from "@preman/core/api/mutate.js";
import { failOnAmbiguity, type SelectionPort } from "./select.js";
import {
  CLI_CERT_LABEL,
  CONFIG_CERT_LABEL,
  NO_ENVIRONMENT_WARNING,
  selectEnvironment,
  selectTarget,
} from "./selection.js";

const HTTP_KIND: RequestKind = "http-request";
const GRPC_KIND: RequestKind = "grpc-request";
/** Highest precedence first, so the named scope is the one `VariableStore.get` answers from. */
const LOOKUP_ORDER: readonly Scope[] = [...SCOPES].reverse();
const TOKEN_NAME_GROUP = 1;
const AUTH_NAME = "auth";
const FORM_FILE_TYPE = "file";
const FILE_BODY_LABEL = "file body";

const SCRIPT_REASON = "not run; a script that sets a header is not in this command";
const TEST_REASON = "a command has no test result";
const WRITEBACK_REASON = "--save writes the environment after a run; a command writes nothing";
const COOKIE_REASON = "populated by earlier responses in a run";
const RUN_OPTION_REASON = "a preman run option, not a request field";
const ITERATION_REASON = "a command is one call";
const PASSPHRASE_REASON = "append it to --cert as :<passphrase> if you need it";

const TEST_FIELD = "pm.test assertions";
const WRITEBACK_FIELD = "variable writeback";
const COOKIE_FIELD = "cookie jar";
const TIMEOUT_FIELD = "timeout";
const ITERATION_FIELD = "iteration data";
const PASSPHRASE_FIELD = "client key passphrase";

export interface PlanCommandArgs {
  /** The workspace directory; only the gRPC dialect reads anything out of it. */
  readonly root: string;
  readonly entry: RequestEntry;
  readonly store: VariableStore;
  /**
   * The request as an editor has it, when that is not yet what is on disk. Absent means read the
   * file, which is what the CLI always does — it has no editor to be out of step with.
   */
  readonly draft?: unknown;
  readonly urlOverride?: string | undefined;
  readonly tlsOverride?: boolean | undefined;
  readonly tlsCerts?: TlsCertOptions | undefined;
  readonly files?: FileReader | undefined;
}

/** `TlsCertOptions` holds bytes; a command line holds the path they were read from. */
function commandCerts(certs: TlsCertOptions | undefined): CommandCerts {
  if (certs === undefined) return NO_CERTS;
  return {
    extraCaCerts: certs.paths.extraCaCerts,
    clientCert: certs.paths.clientCert,
    clientKey: certs.paths.clientKey,
    insecure: certs.insecure,
    passphrase: certs.clientPassphrase !== undefined,
  };
}

/**
 * The `{{token}}` names in an authored string.
 *
 * A fresh `RegExp` per call, for the reason `TOKEN_SOURCE`'s own comment gives: a shared global
 * one carries `lastIndex` between callers.
 */
function tokensIn(text: string, into: Set<string>): void {
  const pattern = new RegExp(TOKEN_SOURCE, "g");
  for (const match of text.matchAll(pattern)) {
    const name = match[TOKEN_NAME_GROUP];
    if (name !== undefined) into.add(name);
  }
}

function scopeOf(name: string, store: VariableStore): Scope | undefined {
  return LOOKUP_ORDER.find((scope) => Object.hasOwn(store.snapshot(scope), name));
}

/**
 * Name every variable whose value is now in the command, and the scope that answered.
 *
 * Not a claim that any of them is a secret: core has no secret, sensitive or redaction concept
 * to lean on, so this reports what was substituted and leaves the judgement to the reader
 * (decision 16). An auth-rendered credential is always here, because `renderAuth` produces one
 * whether or not a variable was behind it and an inherited one is the case the user is least
 * likely to remember (decision 17).
 */
function revealedIn(authored: readonly string[], store: VariableStore): Revealed[] {
  const names = new Set<string>();
  for (const text of authored) tokensIn(text, names);

  const revealed: Revealed[] = [];
  for (const name of names) {
    // A dynamic variable has no scope and no stored value, so there is nothing to leak.
    if (isDynamicVariable(name)) continue;
    const scope = scopeOf(name, store);
    if (scope !== undefined) revealed.push({ name, scope });
  }
  return revealed;
}

function authRevealed(resolved: ResolvedAuth | undefined, store: VariableStore): Revealed | undefined {
  if (resolved === undefined) return undefined;
  const { rendered } = renderAuth(resolved.auth, store);
  if (rendered.kind === "none") return undefined;
  return { name: AUTH_NAME, scope: AUTH_SCOPE, origin: resolved.origin.label };
}

/**
 * The credential strings, whichever shape the file wrote them in.
 *
 * Scanned for `{{token}}` alongside the request's own fields: the auth block is where a
 * variable is most likely to be a credential, and naming `auth` without naming the variable
 * behind it would tell the reader less than they already knew.
 */
function authAuthoredStrings(resolved: ResolvedAuth | undefined): string[] {
  const credentials = resolved?.auth.credentials;
  if (credentials === undefined) return [];
  const values = Array.isArray(credentials) ? credentials.map((entry) => entry.value) : Object.values(credentials);
  return values.filter((value): value is string => typeof value === "string");
}

/**
 * The scripts, named one by one.
 *
 * Never counted and never silent (decision 15): "3 scripts not run" tells a reader nothing about
 * whether the command they are about to paste will work.
 */
function scriptsUnexpressed(
  entry: RequestEntry,
  requestScripts: RequestScript[] | undefined,
  protocol: Protocol,
): { entries: Unexpressed[]; any: boolean } {
  const chain = resolveScriptChain({ ancestors: entry.ancestors, requestScripts, protocol });
  const entries = chain.scripts.map((script) => ({
    field: script.origin.level === "request" ? script.rawType : `${script.origin.label} ${script.rawType}`,
    reason: SCRIPT_REASON,
  }));
  return { entries, any: chain.scripts.length > 0 };
}

/** The run options no command can carry, in both dialects. */
function runOptionsUnexpressed(certs: CommandCerts): Unexpressed[] {
  const entries: Unexpressed[] = [
    { field: COOKIE_FIELD, reason: COOKIE_REASON },
    { field: TIMEOUT_FIELD, reason: RUN_OPTION_REASON },
    { field: ITERATION_FIELD, reason: ITERATION_REASON },
  ];
  if (certs.passphrase) entries.push({ field: PASSPHRASE_FIELD, reason: PASSPHRASE_REASON });
  return entries;
}

/**
 * How the body goes on a curl command line.
 *
 * Read off the authored request rather than the built bytes for the two modes whose bytes are
 * not what a command should carry: a file body's bytes are the file, and a multipart body's are
 * an assembly with a boundary curl will not reuse (decision 32).
 */
function curlBody(
  request: HttpRequest,
  built: { body: string | Buffer | undefined },
  store: VariableStore,
  files: FileReader | undefined,
): CurlBody {
  const mode = request.body?.type?.trim().toLowerCase() ?? "";

  if (mode === FORM_DATA_MODE) {
    const entries: CurlFormEntry[] = [];
    for (const entry of request.body?.formdata ?? []) {
      if (entry.disabled === true) continue;
      const label = `formdata field "${entry.key}"`;
      if (entry.type === FORM_FILE_TYPE) {
        const src = interpolateStrict(entry.src ?? "", store, `${label} source`);
        entries.push({ name: entry.key, value: filePath(src, label, files), file: true });
        continue;
      }
      entries.push({ name: entry.key, value: interpolateStrict(String(entry.value ?? ""), store, label), file: false });
    }
    return { kind: "form", entries };
  }

  if (mode === FILE_MODE) {
    const src = request.body?.file?.src;
    if (src === undefined || src.length === 0) return { kind: "none" };
    const interpolated = interpolateStrict(src, store, FILE_BODY_LABEL);
    return { kind: "file", path: filePath(interpolated, FILE_BODY_LABEL, files) };
  }

  if (built.body === undefined) return { kind: "none" };
  // Every remaining mode produced text; `buildHttpRequest` only yields a Buffer for the two above.
  return { kind: "raw", text: built.body.toString() };
}

/**
 * Where a file-backed part lives, absolutely.
 *
 * The authored `src` is relative to the working dir, which the receiving shell has no reason to
 * be sitting in. Falling back to the authored text when there is no reader keeps a plan
 * renderable without one, at the cost of a path only the author can resolve.
 */
function filePath(src: string, label: string, files: FileReader | undefined): string {
  return files?.resolve(src, label) ?? src;
}

/** The authored strings a variable could have been substituted into, for `revealed`. */
function httpAuthoredStrings(request: HttpRequest): string[] {
  const texts: string[] = [request.url];
  for (const [label, list] of [
    ["headers", request.headers],
    ["queryParams", request.queryParams],
  ] as const) {
    for (const entry of normalizeProperties(list, label)) texts.push(entry.key, entry.value);
  }
  const body = request.body;
  if (body !== undefined) {
    if (typeof body.content === "string") texts.push(body.content);
    else if (body.content !== undefined) {
      for (const entry of normalizeProperties(body.content, "body.content")) texts.push(entry.value);
    }
    for (const entry of normalizeProperties(body.urlencoded, "body.urlencoded")) texts.push(entry.value);
    for (const entry of body.formdata ?? []) texts.push(String(entry.value ?? ""), entry.src ?? "");
    if (body.file?.src !== undefined) texts.push(body.file.src);
    if (body.graphql !== undefined) texts.push(body.graphql.query, body.graphql.variables ?? "");
  }
  return texts;
}

export function planCommand(args: PlanCommandArgs): CommandPlan {
  const parsed = args.draft === undefined ? parseRequestFile(args.entry) : parseRequestDocument(args.draft, args.entry);
  const certs = commandCerts(args.tlsCerts);

  if (parsed.protocol === "http") {
    const request = parsed.request;
    const auth = resolveAuth(args.entry, request.auth);
    const built = buildHttpRequest({
      request,
      auth,
      store: args.store,
      urlOverride: args.urlOverride,
      tlsOverride: args.tlsOverride,
      files: args.files,
    });
    const body = curlBody(request, built, args.store, args.files);
    const rendered = renderCurl(built, { body, certs });
    const scripts = scriptsUnexpressed(args.entry, request.scripts, "http");

    const unexpressed: Unexpressed[] = [...scripts.entries];
    if (scripts.any) {
      unexpressed.push({ field: TEST_FIELD, reason: TEST_REASON });
      unexpressed.push({ field: WRITEBACK_FIELD, reason: WRITEBACK_REASON });
    }
    unexpressed.push(...runOptionsUnexpressed(certs));

    const credential = authRevealed(auth, args.store);
    const revealed = [
      ...(credential === undefined ? [] : [credential]),
      ...revealedIn([...httpAuthoredStrings(request), ...authAuthoredStrings(auth)], args.store),
    ];

    return {
      format: CURL_FORMAT,
      kind: HTTP_KIND,
      words: rendered.words,
      command: quoteWords(rendered.words),
      unexpressed,
      revealed,
      warnings: [...built.warnings, ...rendered.warnings],
    };
  }

  const request = parsed.request;
  const workspace = requireWorkspace(args.root);
  const resources = loadResources(workspace);
  const call = resolveGrpcCall({
    entry: args.entry,
    request,
    store: args.store,
    workspaceRoot: workspace.root,
    urlOverride: args.urlOverride,
    tlsOverride: args.tlsOverride,
    includeDirsFor: resources.includeDirsFor,
  });
  const rendered = renderGrpcurl(call, { certs, includeDirsFor: resources.includeDirsFor });
  const scripts = scriptsUnexpressed(args.entry, request.scripts, "grpc");

  const unexpressed: Unexpressed[] = [...rendered.unexpressed, ...scripts.entries];
  if (scripts.any) {
    unexpressed.push({ field: TEST_FIELD, reason: TEST_REASON });
    unexpressed.push({ field: WRITEBACK_FIELD, reason: WRITEBACK_REASON });
  }
  unexpressed.push(...runOptionsUnexpressed(certs));

  const credential = authRevealed(call.auth, args.store);
  const authored = [
    request.url,
    request.methodPath,
    request.message?.content ?? "",
    ...normalizeProperties(request.metadata, "metadata").map((entry) => entry.value),
    ...authAuthoredStrings(call.auth),
  ];
  const revealed = [...(credential === undefined ? [] : [credential]), ...revealedIn(authored, args.store)];

  return {
    format: GRPCURL_FORMAT,
    kind: GRPC_KIND,
    words: rendered.words,
    command: quoteWords(rendered.words),
    unexpressed,
    revealed,
    warnings: [...call.warnings, ...rendered.warnings],
  };
}

export interface CopySelectionArgs {
  readonly dir: string;
  readonly selector: string | undefined;
  /** Same three-valued contract as `runSelection`: a name, `null` for none, `undefined` to ask. */
  readonly env: string | null | undefined;
  readonly url: string | undefined;
  readonly tls: boolean | undefined;
  readonly tlsCerts: TlsCertInput;
  /** Where relative certificate paths are anchored. Distinct from `dir`. */
  readonly certBaseDir: string;
  readonly vars: Record<string, string>;
  readonly workingDir: string | undefined;
  readonly insecureFileRead: boolean;
  readonly select?: SelectionPort;
  /** Passed through to {@link planCommand}. The selector still has to name a real file. */
  readonly draft?: unknown;
}

export interface CopySelectionResult {
  readonly plan: CommandPlan;
  /** About the workspace — the environment and the certificates. The request's own are on `plan`. */
  readonly warnings: readonly string[];
}

/**
 * Resolve a selector to one request and plan its command.
 *
 * The counterpart of `runSelection`, and it takes run's target options for the reason decision 27
 * gives: a command that ignored the `--env`, `--url` and `--ssl-*` a run would honour is a command
 * for a different call. It reuses that path's environment selection rather than repeating it, so
 * `preman copy` and `preman run` cannot disagree about which environment is in play.
 */
export async function copySelection(args: CopySelectionArgs): Promise<CopySelectionResult> {
  const port = args.select ?? failOnAmbiguity;
  const ws = requireWorkspace(args.dir);
  const requests = listRequests(ws);
  const selected = await selectTarget(requests, args.selector, port);
  // One request per copy (decision 28). N commands is not a command, and the pane shows one
  // document; the count is what tells the user their selector was wider than they meant.
  if (selected.kind === "group") {
    throw new PremanError(
      `"${selected.group.path}" is a ${selected.group.kind} of ${selected.group.requests.length} requests`,
      {
        exitCode: EXIT.CLI,
        details: ["copy one request at a time", ...selected.group.requests.map((entry) => `  ${entry.path}`)],
      },
    );
  }
  const target = selected.entry;
  const environment = await selectEnvironment(ws, args.env, port);
  const warnings: string[] = environment === undefined ? [NO_ENVIRONMENT_WARNING] : [];

  const config = loadPremanConfig(ws);
  const tlsCerts = resolveTlsCerts([
    { label: CLI_CERT_LABEL, baseDir: args.certBaseDir, input: args.tlsCerts },
    ...(config === undefined ? [] : [{ label: CONFIG_CERT_LABEL, baseDir: config.baseDir, input: config.tls }]),
  ]);
  warnings.push(...tlsCerts.warnings);

  const store = new VariableStore({
    globals: loadGlobals(ws),
    data: {},
    environment: environment?.values ?? {},
    local: args.vars,
  });

  const plan = planCommand({
    root: ws.root,
    entry: target,
    store,
    draft: args.draft,
    urlOverride: args.url,
    tlsOverride: args.tls,
    tlsCerts,
    files: fileReader({ workingDir: args.workingDir ?? ws.root, allowOutside: args.insecureFileRead }),
  });

  // The workspace-level warnings only. The plan carries its own, about the one request, and a
  // caller that printed both would say each of them twice.
  return { plan, warnings };
}

export type { CommandPlan, Revealed, Unexpressed };
