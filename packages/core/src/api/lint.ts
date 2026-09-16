/**
 * Read every request in a workspace and report the authored fields preman will not honour.
 *
 * The runner already knows most of this. `buildBody` returns warnings beside its bytes,
 * `applyAuth` returns them beside its header, and `runner.ts` collects both — but only while a
 * call is going out. That is too late to be a review tool and too expensive to be one: learning
 * that a field is ignored should not cost a request to a real server, and for a mutating request
 * it is not an affordable question at all.
 *
 * So the rules here are static twins of those run-time checks: same conditions, no variable
 * store, no sockets, no files sent. The duplication is deliberate and is the cost recorded in
 * ADR 057 — a rule that drifts from its twin is a bug in this file, and the fixtures in
 * `test/lint.test.ts` pin each one to the branch it mirrors.
 *
 * What is *not* here, equally deliberately: anything needing a resolved variable. A `{{token}}`
 * may be set by a script in another request, so an unresolved one is not evidence of a mistake.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { SUPPORTED_AUTH_TYPES } from "@preman/core/auth/credentials.js";
import { PremanError } from "@preman/core/errors.js";
import {
  BODY_CONTENT_TYPES,
  FILE_MODE,
  FORM_DATA_MODE,
  GRAPHQL_MODE,
  RAW_MODE,
  URLENCODED_MODE,
} from "@preman/core/http/body.js";
import { listRequests, type RequestEntry } from "@preman/core/workspace/collections.js";
import { requireWorkspace } from "@preman/core/workspace/discover.js";
import { nodeIdFor } from "@preman/core/workspace/paths.js";
import { parseRequestFile, RUNNABLE_KINDS } from "@preman/core/workspace/request-file.js";
import type {
  AuthCredentials,
  GrpcRequest,
  HttpRequest,
  KeyValueSource,
  RequestAuth,
} from "@preman/core/workspace/schemas.js";
import { describeSpecs } from "./specs.js";

export type LintSeverity = "error" | "warning";

/**
 * Stable identifiers, so a finding can be grepped for and a report diffed between runs.
 * `error` means the request cannot do what it says; `warning` means it will, but something the
 * author wrote is being dropped on the way.
 */
export const LINT_RULES = {
  shape: "shape",
  bodyPartsMissing: "body-parts-missing",
  bodyPartsDisabled: "body-parts-disabled",
  bodyPartsIgnored: "body-parts-ignored",
  bodyContentIgnored: "body-content-ignored",
  bodyContentNotText: "body-content-not-text",
  bodyTypeUnknown: "body-type-unknown",
  bodyFileMissing: "body-file-missing",
  bodyFileAbsent: "body-file-absent",
  authTypeUnknown: "auth-type-unknown",
  authHeaderReplaced: "auth-header-replaced",
  kindUnsupported: "kind-unsupported",
  grpcSchemaAbsent: "grpc-schema-absent",
  grpcSchemaDescriptorOnly: "grpc-schema-descriptor-only",
  specAbsent: "spec-absent",
} as const;

export type LintRule = (typeof LINT_RULES)[keyof typeof LINT_RULES];

export interface LintFinding {
  readonly rule: LintRule;
  readonly severity: LintSeverity;
  readonly message: string;
  /** Dotted path into the request document, or `undefined` for a workspace-level finding. */
  readonly field: string | undefined;
  /** What to do about it. Never empty: a finding nobody can act on is noise. */
  readonly remedy: string;
}

export interface LintedRequest {
  /** `collection/folder/name`, the same selector `preman run` takes. */
  readonly path: string;
  /** Posix-relative node id, for an editor that wants to open the file. */
  readonly file: string;
  readonly findings: readonly LintFinding[];
}

export interface LintReport {
  readonly root: string;
  /** Workspace-wide findings: declared protos and the links they need. */
  readonly workspace: readonly LintFinding[];
  /** Only the requests that have something to say. `checked` is the denominator. */
  readonly requests: readonly LintedRequest[];
  readonly checked: number;
  readonly errors: number;
  readonly warnings: number;
}

const GRPC_PROTOCOL = "grpc";
const NO_AUTH = "noauth";
const AUTH_HEADER = "authorization";
const API_KEY_TYPE = "apikey";
const API_KEY_IN_QUERY = "query";
const BEARER_TYPE = "bearer";
const BASIC_TYPE = "basic";
const TOKEN_OPEN = "{{";
const EMPTY = 0;

/** The modes `buildBody` dispatches on by name, before it falls through to the raw path. */
const STRUCTURED_MODES = new Set<string>([FORM_DATA_MODE, URLENCODED_MODE, FILE_MODE, GRAPHQL_MODE]);
/**
 * Everything `buildBody` can reach without warning. `none` is not one of core's modes — it is
 * what the desktop writes for "no body" (`renderer/model/request.ts:29`), and core reaches the
 * raw path with nothing to send, which is the same thing. Linting it would be linting the GUI.
 */
const NO_BODY_MODE = "none";
const KNOWN_MODES = new Set<string>([
  ...STRUCTURED_MODES,
  RAW_MODE,
  NO_BODY_MODE,
  "",
  ...Object.keys(BODY_CONTENT_TYPES),
]);

/** Which `body.<field>` each mode reads its payload out of, for the "wrong field" rules. */
const MODE_FIELDS: Record<string, string> = {
  [FORM_DATA_MODE]: "formdata",
  [URLENCODED_MODE]: "urlencoded",
  [FILE_MODE]: "file",
  [GRAPHQL_MODE]: "graphql",
};

function finding(
  rule: LintRule,
  severity: LintSeverity,
  field: string | undefined,
  message: string,
  remedy: string,
): LintFinding {
  return { rule, severity, field, message, remedy };
}

/** A path preman could not check statically, because a variable decides what it is. */
function isTemplated(value: string): boolean {
  return value.includes(TOKEN_OPEN);
}

function resolveAgainst(base: string, src: string): string {
  return isAbsolute(src) ? src : resolve(base, src);
}

/**
 * Read one credential without a store. Only used to name a header, so a templated value is
 * reported as absent rather than guessed at — the caller skips the rule in that case.
 */
function rawCredential(credentials: AuthCredentials | undefined, name: string): string | undefined {
  if (credentials === undefined) return undefined;
  const found = Array.isArray(credentials) ? credentials.find((entry) => entry.key === name)?.value : credentials[name];
  return typeof found === "string" ? found : undefined;
}

/** Header keys as authored, lower-cased, from either the map or the list shape. */
function headerKeys(source: KeyValueSource | undefined): string[] {
  if (source === undefined || typeof source !== "object" || source === null) return [];
  const keys = Array.isArray(source) ? source.map((entry) => entry.key) : Object.keys(source);
  return keys.map((key) => key.trim().toLowerCase()).filter((key) => key.length > EMPTY);
}

/**
 * Which header the `auth` block will occupy, or `undefined` when it will occupy none —
 * mirroring `renderAuth`, including its two unauthenticated fallbacks.
 */
function authHeaderName(auth: RequestAuth, type: string): string | undefined {
  if (type === BEARER_TYPE) {
    const token = rawCredential(auth.credentials, "token");
    return token === undefined || token.length === EMPTY ? undefined : AUTH_HEADER;
  }
  if (type === BASIC_TYPE) return AUTH_HEADER;

  const key = rawCredential(auth.credentials, "key");
  if (key === undefined || key.length === EMPTY || isTemplated(key)) return undefined;
  const target = (rawCredential(auth.credentials, "in") ?? "").trim().toLowerCase();
  return target === API_KEY_IN_QUERY ? undefined : key.trim().toLowerCase();
}

function lintAuth(auth: RequestAuth | undefined, headers: KeyValueSource | undefined): LintFinding[] {
  if (auth === undefined) return [];
  const type = auth.type.trim().toLowerCase();
  if (type.length === EMPTY || type === NO_AUTH) return [];

  if (!SUPPORTED_AUTH_TYPES.includes(type as (typeof SUPPORTED_AUTH_TYPES)[number])) {
    return [
      finding(
        LINT_RULES.authTypeUnknown,
        "error",
        "auth.type",
        `auth type "${auth.type}" is not supported; the request throws before it is sent`,
        `use one of: ${SUPPORTED_AUTH_TYPES.join(", ")}`,
      ),
    ];
  }

  // ADR 050: the block wins, so a header of the same name is authored for nothing.
  const occupied = authHeaderName(auth, type);
  if (occupied === undefined || !headerKeys(headers).includes(occupied)) return [];
  const shown = occupied === AUTH_HEADER ? "Authorization" : occupied;
  return [
    finding(
      LINT_RULES.authHeaderReplaced,
      "warning",
      `headers.${shown}`,
      `${type === API_KEY_TYPE ? API_KEY_TYPE : type} auth replaces the authored "${shown}" header`,
      "delete the auth block to send the header instead, or delete the header",
    ),
  ];
}

/** Parts authored under a field the declared mode never reads. */
function lintStrayParts(body: NonNullable<HttpRequest["body"]>, mode: string): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const [owner, field] of Object.entries(MODE_FIELDS)) {
    if (owner === mode || body[field as keyof typeof body] === undefined) continue;
    findings.push(
      finding(
        LINT_RULES.bodyPartsIgnored,
        "warning",
        `body.${field}`,
        `body.${field} is never read because body.type is ${mode.length === EMPTY ? "not set" : `"${mode}"`}`,
        `set body.type: ${owner}, or delete body.${field}`,
      ),
    );
  }
  return findings;
}

/**
 * The formdata parts themselves. Disabled entries are skipped for the same reason
 * `multipartBody` filters before it validates: a commented-out part is not a mistake.
 */
function lintFormDataEntries(body: NonNullable<HttpRequest["body"]>, base: string): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const entry of body.formdata ?? []) {
    if (entry.disabled === true || entry.type !== "file") continue;
    if (entry.src === undefined || entry.src.length === EMPTY) {
      findings.push(
        finding(
          LINT_RULES.bodyFileMissing,
          "error",
          `body.formdata.${entry.key}.src`,
          `formdata part "${entry.key}" is a file with no src; the request throws before it is sent`,
          "add src, change type to text, or set disabled: true",
        ),
      );
      continue;
    }
    if (isTemplated(entry.src) || existsSync(resolveAgainst(base, entry.src))) continue;
    findings.push(
      finding(
        LINT_RULES.bodyFileAbsent,
        "error",
        `body.formdata.${entry.key}.src`,
        `formdata part "${entry.key}" names "${entry.src}", which is not on disk`,
        "correct the path, or set disabled: true until the file exists",
      ),
    );
  }
  return findings;
}

/** `type: formdata` reads its parts from `body.formdata` and from nowhere else. */
function lintFormDataBody(body: NonNullable<HttpRequest["body"]>): LintFinding[] {
  if (body.formdata === undefined) {
    // The likeliest cause by far, and the one that reads as valid: parts written under
    // `content`, the key every other mode uses. Say so rather than only that parts are absent.
    const misplaced = body.content !== undefined;
    return [
      finding(
        LINT_RULES.bodyPartsMissing,
        "error",
        "body.formdata",
        misplaced
          ? "body.content is not read by type formdata, and body.formdata is absent: no body is sent"
          : "body.type is formdata but body.formdata is absent: no body is sent",
        misplaced ? "rename body.content to body.formdata" : "add body.formdata with the parts to send",
      ),
    ];
  }

  const findings: LintFinding[] = [];
  if (body.content !== undefined) {
    findings.push(
      finding(
        LINT_RULES.bodyContentIgnored,
        "warning",
        "body.content",
        "body.content is ignored because body.formdata is present",
        "delete body.content",
      ),
    );
  }
  if (body.formdata.every((entry) => entry.disabled === true) && body.formdata.length > EMPTY) {
    findings.push(
      finding(
        LINT_RULES.bodyPartsDisabled,
        "warning",
        "body.formdata",
        "every formdata part is disabled: no body is sent",
        "enable a part, or set body.type: none",
      ),
    );
  }
  return findings;
}

function lintBody(request: HttpRequest, base: string): LintFinding[] {
  const body = request.body;
  if (body === undefined) return [];

  const mode = body.type?.trim().toLowerCase() ?? "";
  const findings: LintFinding[] = [...lintStrayParts(body, mode)];

  if (mode === FORM_DATA_MODE) {
    return [...findings, ...lintFormDataBody(body), ...lintFormDataEntries(body, base)];
  }

  if (mode === URLENCODED_MODE) {
    // Unlike formdata, `content` is a legal second home for these parts, so its presence is
    // only worth saying when `urlencoded` is there to beat it.
    if (body.urlencoded !== undefined && body.content !== undefined) {
      findings.push(
        finding(
          LINT_RULES.bodyContentIgnored,
          "warning",
          "body.content",
          "body.content is ignored because body.urlencoded is present",
          "delete body.content",
        ),
      );
    }
    if (body.urlencoded === undefined && body.content === undefined) {
      findings.push(
        finding(
          LINT_RULES.bodyPartsMissing,
          "error",
          "body.urlencoded",
          "body.type is urlencoded but no fields are declared: no body is sent",
          "add body.urlencoded with the fields to send",
        ),
      );
    }
    return findings;
  }

  if (mode === FILE_MODE) {
    const src = body.file?.src;
    if (src === undefined || src.length === EMPTY) {
      findings.push(
        finding(
          LINT_RULES.bodyFileMissing,
          "error",
          "body.file.src",
          "body.type is file but body.file.src is absent: no body is sent",
          "add body.file.src",
        ),
      );
    } else if (!isTemplated(src) && !existsSync(resolveAgainst(base, src))) {
      findings.push(
        finding(
          LINT_RULES.bodyFileAbsent,
          "error",
          "body.file.src",
          `body.file.src names "${src}", which is not on disk`,
          "correct the path",
        ),
      );
    }
    return findings;
  }

  if (mode === GRAPHQL_MODE) {
    if (body.graphql === undefined) {
      findings.push(
        finding(
          LINT_RULES.bodyPartsMissing,
          "error",
          "body.graphql",
          "body.type is graphql but body.graphql is absent: no body is sent",
          "add body.graphql.query",
        ),
      );
    }
    return findings;
  }

  // The raw path. `readRequestBody` throws here rather than serialising a map nobody asked it to.
  if (body.content !== undefined && typeof body.content !== "string") {
    findings.push(
      finding(
        LINT_RULES.bodyContentNotText,
        "error",
        "body.content",
        `body.content is a ${Array.isArray(body.content) ? "list" : "map"}, which is only legal for type urlencoded`,
        "write the payload as a string, or set body.type: urlencoded",
      ),
    );
  }
  // Gated on there being content, because that is what the runner gates on: a mode with nothing
  // under it generates no Content-Type either way, so there is nothing to tell the author.
  const hasContent = typeof body.content === "string" && body.content.length > EMPTY;
  if (hasContent && !KNOWN_MODES.has(mode)) {
    findings.push(
      finding(
        LINT_RULES.bodyTypeUnknown,
        "warning",
        "body.type",
        `body.type "${mode}" is not one preman knows; the content is sent with no generated Content-Type`,
        "use a known type, or set the Content-Type header yourself",
      ),
    );
  }
  return findings;
}

/**
 * A gRPC request whose declared .proto is not where it says it is. Fatal only when there is no
 * embedded descriptor to fall back on — `grpc/schema.ts:200` treats the two cases differently,
 * and so must this, or every descriptor-only request imported from the cloud reads as broken.
 */
function lintGrpcSchema(request: GrpcRequest, requestFile: string): LintFinding[] {
  const location = request.schema?.location;
  if (location === undefined || location.length === EMPTY || isTemplated(location)) return [];
  if (existsSync(resolveAgainst(dirname(requestFile), location))) return [];

  const hasDescriptor = request.methodDescriptor !== undefined && request.methodDescriptor.length > EMPTY;
  return [
    hasDescriptor
      ? finding(
          LINT_RULES.grpcSchemaDescriptorOnly,
          "warning",
          "schema.location",
          `schema.location names "${location}", which is not on disk; the embedded descriptor is used instead`,
          "correct the path to edit against the .proto; the descriptor may be stale or partial",
        )
      : finding(
          LINT_RULES.grpcSchemaAbsent,
          "error",
          "schema.location",
          `schema.location names "${location}", which is not on disk and there is no descriptor to fall back to`,
          "correct the path, or run `preman protos` to see which links are missing",
        ),
  ];
}

function lintRequest(entry: RequestEntry, root: string): LintFinding[] {
  // A kind preman has not implemented is not a malformed file, and grading it `error` would mean
  // one websocket request a user is not trying to run fails the whole workspace.
  if (!RUNNABLE_KINDS.has(entry.kind)) {
    return [
      finding(
        LINT_RULES.kindUnsupported,
        "warning",
        "$kind",
        `${entry.kind} is not a kind preman can run yet; it is skipped`,
        `supported kinds: ${[...RUNNABLE_KINDS].join(", ")}`,
      ),
    ];
  }

  let parsed;
  try {
    parsed = parseRequestFile(entry);
  } catch (cause) {
    // A request that will not parse is reported, not thrown: one bad file must not hide the
    // rest of the workspace, which is the whole reason to run this over a tree.
    const error = cause instanceof PremanError ? cause : undefined;
    const message = error?.message ?? (cause as Error).message;
    return [
      finding(
        LINT_RULES.shape,
        "error",
        undefined,
        message,
        error === undefined || error.details.length === EMPTY ? "fix the file" : error.details.join("; "),
      ),
    ];
  }

  if (parsed.protocol === GRPC_PROTOCOL) {
    return [
      ...lintAuth(parsed.request.auth, parsed.request.metadata),
      ...lintGrpcSchema(parsed.request, entry.filePath),
    ];
  }
  return [...lintAuth(parsed.request.auth, parsed.request.headers), ...lintBody(parsed.request, root)];
}

/**
 * Only the protos this workspace declares. `SpecsView.unresolvedLinks` is deliberately not read:
 * the shared root is machine-wide, so a link this workspace never touches would otherwise fail
 * its lint — and a link that *is* touched already shows up as the spec on it not existing.
 */
function lintSpecs(dir: string): LintFinding[] {
  const view = describeSpecs(dir);
  return view.specs
    .filter((spec) => !spec.exists)
    .map((spec) =>
      finding(
        LINT_RULES.specAbsent,
        "error",
        undefined,
        `declared proto "${spec.declared}" resolves to ${spec.path}, which is not on disk`,
        spec.link === undefined
          ? "correct the path in .postman/resources.yaml"
          : `preman protos link ${spec.link} <dir>`,
      ),
    );
}

/**
 * Lint every request in the workspace. Never throws for a bad request — only for a missing
 * workspace, which is the one condition that leaves nothing to report.
 */
export function lintWorkspace(dir: string): LintReport {
  const ws = requireWorkspace(dir);
  const entries = listRequests(ws);

  const requests: LintedRequest[] = [];
  for (const entry of entries) {
    const findings = lintRequest(entry, ws.root);
    if (findings.length === EMPTY) continue;
    requests.push({ path: entry.path, file: nodeIdFor(ws.root, entry.filePath), findings });
  }

  const workspace = lintSpecs(dir);
  const all = [...workspace, ...requests.flatMap((request) => request.findings)];
  return {
    root: ws.root,
    workspace,
    requests,
    checked: entries.length,
    errors: all.filter((item) => item.severity === "error").length,
    warnings: all.filter((item) => item.severity === "warning").length,
  };
}
