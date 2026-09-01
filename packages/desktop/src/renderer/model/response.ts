/**
 * What a finished (or in-flight) request looks like to the response pane, and the small
 * amount of arithmetic that turns it into something paintable.
 *
 * The shapes are pulled off `RunEvent` rather than re-declared, so the pane cannot drift
 * from the wire. They live here rather than in `stores/runs.ts` because the console
 * drawer, the headers table and the tests list all need them and none of them should have
 * to import a store to name a type.
 *
 * Everything here is pure. Nothing imports React, and nothing reads a store.
 */
import { EXIT_CODES, type ExitCode, type FailureStage, type RunEvent } from "@preman/desktop/engine/protocol.js";

/* The sandbox's and the transport's own shapes, as they arrive. */
export type ConsoleLine = Extract<RunEvent, { type: "console" }>["line"];
export type ConsoleLevel = ConsoleLine["level"];
export type TestResult = Extract<RunEvent, { type: "test" }>["result"];
export type TestStatus = TestResult["status"];
export type SideRequestSummary = Extract<RunEvent, { type: "side-request" }>["summary"];
/** What the runner actually put on the wire, discriminated by protocol. */
export type SentRequest = Extract<RunEvent, { type: "request-sent" }>["sent"];
export type ResponseHead = Omit<Extract<RunEvent, { type: "response-head" }>, "type" | "runId" | "nodeId">;
export type ResponseBody = Omit<Extract<RunEvent, { type: "response-body" }>, "type" | "runId" | "nodeId">;
export type ResponseFailure = Omit<Extract<RunEvent, { type: "response-failure" }>, "type" | "runId" | "nodeId">;
export type HeaderPairs = ResponseHead["headers"];

/**
 * The four ways anything in the pane can read. Named rather than passing colours around,
 * because `app.css` owns the palette and a pane that picked its own would escape the
 * contrast audit.
 */
export type Tone = "ok" | "warn" | "danger" | "neutral";

/**
 * The one place a tone becomes a class. Three panes read tones - the response pane, the console
 * drawer and the runner - and three copies of this record is three places for the palette to
 * drift out from under the contrast audit in `app.css`. It lives here rather than in `ui/`
 * because the tones themselves are decided in this file.
 */
const TONE_CLASS: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  neutral: "text-ink-dim",
};

export function toneClass(tone: Tone): string {
  return TONE_CLASS[tone];
}

/**
 * The filled variant, for a status worn as a tag rather than set as text. It sits beside
 * `TONE_CLASS` so that the palette stays in one file and the contrast audit in `app.css`
 * has one place to look: every pair below is ink on its own tint over `--color-panel`.
 *
 * Neutral takes `--color-control` rather than a grey tint, because a grey wash on a grey
 * surface is not a tag, it is a smudge.
 */
const TONE_TAG_CLASS: Record<Tone, string> = {
  ok: "bg-ok/10 text-ok",
  warn: "bg-warn/10 text-warn",
  danger: "bg-danger/10 text-danger",
  neutral: "bg-control text-ink-dim",
};

export function toneTagClass(tone: Tone): string {
  return TONE_TAG_CLASS[tone];
}

const HTTP_SUCCESS_MIN = 200;
const HTTP_REDIRECT_MIN = 300;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;
/** gRPC statuses arrive as their code name, and exactly one of them is success. */
const GRPC_OK = "OK";

/**
 * Which failures the caller can fix, and which mean the far side broke.
 *
 * The split is not invented here: it is the canonical mapping in `google/rpc/code.proto`,
 * the one grpc-gateway uses to turn a status into an HTTP code. Every status it maps to a
 * 4xx reads warn and every 5xx reads danger, so `NOT_FOUND` and `404` are the same colour
 * for the same event - which they were not before, when every non-`OK` status was red and
 * a gRPC call therefore looked worse than the identical HTTP call.
 *
 * A name this build has never heard of falls through to danger: an unrecognised status is
 * not evidence that the caller can fix it.
 */
const GRPC_STATUS_TONE: Record<string, Tone> = {
  [GRPC_OK]: "ok",
  CANCELLED: "warn", // 499
  UNKNOWN: "danger", // 500
  INVALID_ARGUMENT: "warn", // 400
  DEADLINE_EXCEEDED: "danger", // 504
  NOT_FOUND: "warn", // 404
  ALREADY_EXISTS: "warn", // 409
  PERMISSION_DENIED: "warn", // 403
  RESOURCE_EXHAUSTED: "warn", // 429
  FAILED_PRECONDITION: "warn", // 400
  ABORTED: "warn", // 409
  OUT_OF_RANGE: "warn", // 400
  UNIMPLEMENTED: "danger", // 501
  INTERNAL: "danger", // 500
  UNAVAILABLE: "danger", // 503
  DATA_LOSS: "danger", // 500
  UNAUTHENTICATED: "warn", // 401
};

/**
 * A gRPC status is a string, an HTTP status is a number, and `response-head` carries
 * whichever the transport produced. Redirects read neutral rather than ok: the engine
 * follows them itself, so a 3xx that survived to the pane means the chain stopped there.
 */
export function statusTone(status: number | string): Tone {
  if (typeof status === "string") return GRPC_STATUS_TONE[status] ?? "danger";
  if (status >= HTTP_SERVER_ERROR_MIN) return "danger";
  if (status >= HTTP_CLIENT_ERROR_MIN) return "warn";
  if (status >= HTTP_SUCCESS_MIN && status < HTTP_REDIRECT_MIN) return "ok";
  return "neutral";
}

export function statusText(status: number | string): string {
  return typeof status === "string" ? status : String(status);
}

/**
 * What a failed call is called, and what to do about it.
 *
 * The status name alone tells the reader who already knew what it meant. This table is
 * for the one who did not, and it is here rather than in the pane because deciding what
 * a status *means* is the same job as deciding what tone it reads in.
 */
export interface FailureCopy {
  readonly title: string;
  readonly hint: string;
}

/** Keyed by gRPC code name, which is what `response-head` carries for a gRPC call. */
const GRPC_FAILURE_COPY: Record<string, FailureCopy> = {
  CANCELLED: {
    title: "The call was cancelled",
    hint: "Something on either end gave up before the server answered.",
  },
  UNKNOWN: {
    title: "The server failed without saying why",
    hint: "It threw before it could set a status. Its own logs will have more than this.",
  },
  INVALID_ARGUMENT: {
    title: "The request was rejected",
    hint: "The server understood the message and refused it. Check the fields it names below.",
  },
  DEADLINE_EXCEEDED: {
    title: "The call ran out of time",
    hint: "The deadline passed before an answer arrived. Raise the timeout, or find what the server is waiting on.",
  },
  NOT_FOUND: {
    title: "Could not find the entity",
    hint: "The server looked and found nothing. Check the identifiers in the message you sent.",
  },
  ALREADY_EXISTS: {
    title: "The entity already exists",
    hint: "The server refused to create something it already has.",
  },
  PERMISSION_DENIED: {
    title: "Not allowed to call this",
    hint: "The caller was identified and refused. This is authorisation, not authentication.",
  },
  RESOURCE_EXHAUSTED: {
    title: "The server is out of a resource",
    hint: "A quota, a rate limit, or a message larger than it accepts.",
  },
  FAILED_PRECONDITION: {
    title: "The system is not in a state for this",
    hint: "The call is valid but the server is not ready for it. Retrying it unchanged will fail the same way.",
  },
  ABORTED: {
    title: "The call was aborted",
    hint: "Usually a concurrency conflict. Retrying may work.",
  },
  OUT_OF_RANGE: {
    title: "A value was out of range",
    hint: "The server was asked to read past the end of something.",
  },
  UNIMPLEMENTED: {
    title: "The server does not implement this method",
    hint: "Check the method path, and that the server runs the schema you are compiling against.",
  },
  INTERNAL: {
    title: "The server broke",
    hint: "An invariant failed inside it. Its own logs will have more than this.",
  },
  UNAVAILABLE: {
    title: "Could not reach the server",
    hint: "It is down, restarting, or the address is wrong. Retrying may work.",
  },
  DATA_LOSS: {
    title: "Data was lost",
    hint: "Unrecoverable on the server's side.",
  },
  UNAUTHENTICATED: {
    title: "The caller was not authenticated",
    hint: "No valid credentials were presented. Check the auth on this request, or on a folder above it.",
  },
};

const UNKNOWN_FAILURE: FailureCopy = {
  title: "The call failed",
  hint: "The server refused the call with a status this build does not recognise.",
};

/** No status at all is HTTP's way of saying the socket never produced one. */
const NO_RESPONSE_FAILURE: FailureCopy = {
  title: "No response arrived",
  hint: "The request never reached a server that answered. The message below is what the socket reported.",
};

/**
 * Nothing was sent, so no status exists and none is implied. Saying "no response
 * arrived" here would be a lie of omission: no request was placed to answer.
 */
const BUILD_FAILURE: FailureCopy = {
  title: "The request could not be built",
  hint: "preman stopped before sending anything. The message below says what it could not resolve.",
};

/**
 * A numeric status never reaches here: HTTP emits a failure only when it has no status,
 * because a 4xx or 5xx has a body and the body is the server's own account of the error.
 * If one ever does, this under-explains rather than throwing - a pane that crashes on an
 * unexpected status is worse than one that says less than it could.
 */
export function failureCopy(stage: FailureStage, status: number | string | undefined): FailureCopy {
  if (stage === "build") return BUILD_FAILURE;
  if (status === undefined) return NO_RESPONSE_FAILURE;
  if (typeof status === "number") return UNKNOWN_FAILURE;
  return GRPC_FAILURE_COPY[status] ?? UNKNOWN_FAILURE;
}

/** The words behind the exit codes, so the pane never shows a bare number. */
const EXIT_LABEL: Record<ExitCode, string> = {
  [EXIT_CODES.OK]: "ok",
  [EXIT_CODES.CLI]: "configuration",
  [EXIT_CODES.TRANSPORT]: "transport",
  [EXIT_CODES.BUSINESS]: "return code",
  [EXIT_CODES.TEST]: "test failed",
};

/**
 * A non-zero `return_code` is the server answering, not the call breaking, so it reads as
 * a warning. Everything else that is not ok is a failure.
 */
const EXIT_TONE: Record<ExitCode, Tone> = {
  [EXIT_CODES.OK]: "ok",
  [EXIT_CODES.CLI]: "danger",
  [EXIT_CODES.TRANSPORT]: "danger",
  [EXIT_CODES.BUSINESS]: "warn",
  [EXIT_CODES.TEST]: "danger",
};

export function exitLabel(exitCode: ExitCode): string {
  return EXIT_LABEL[exitCode];
}

export function exitTone(exitCode: ExitCode): Tone {
  return EXIT_TONE[exitCode];
}

/**
 * A clean exit is already told by the status and the tests, so a summary line that also
 * says "ok" is saying it a third time. Only the failures carry information worth the space.
 */
export function isCleanExit(exitCode: ExitCode): boolean {
  return exitCode === EXIT_CODES.OK;
}

const LEVEL_TONE: Record<ConsoleLevel, Tone> = {
  log: "neutral",
  info: "neutral",
  warn: "warn",
  error: "danger",
  debug: "neutral",
};

export function levelTone(level: ConsoleLevel): Tone {
  return LEVEL_TONE[level];
}

const STATUS_TONE: Record<TestStatus, Tone> = {
  passed: "ok",
  failed: "danger",
  skipped: "neutral",
};

export function testTone(status: TestStatus): Tone {
  return STATUS_TONE[status];
}

export interface TestTotals {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number;
}

export const NO_TESTS: TestTotals = { passed: 0, failed: 0, skipped: 0, total: 0 };

/**
 * One more result folded into a running count.
 *
 * A whole-run total has to be accumulated as the events arrive, not folded over the items when it
 * is read: a collection over a data file is thousands of items, and re-scanning all of them on
 * every assertion is quadratic in the length of the run.
 */
export function addTest(totals: TestTotals, result: TestResult): TestTotals {
  return {
    passed: totals.passed + (result.status === "passed" ? 1 : 0),
    failed: totals.failed + (result.status === "failed" ? 1 : 0),
    skipped: totals.skipped + (result.status === "skipped" ? 1 : 0),
    total: totals.total + 1,
  };
}

export function testTotals(tests: readonly TestResult[]): TestTotals {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const test of tests) {
    if (test.status === "passed") passed += 1;
    else if (test.status === "failed") failed += 1;
    else skipped += 1;
  }
  return tests.length === 0 ? NO_TESTS : { passed, failed, skipped, total: tests.length };
}

const SET_COOKIE = "set-cookie";
const COOKIE_SEPARATOR = ";";
const ATTRIBUTE_SEPARATOR = "=";
const NOT_FOUND = -1;
const HTTP_ONLY = "httponly";
const SECURE = "secure";
const DOMAIN = "domain";
const PATH = "path";
const EXPIRES = "expires";
const MAX_AGE = "max-age";
const SAME_SITE = "samesite";
const ABSENT = "";

export interface CookieRow {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  /** `Expires` verbatim, or the `Max-Age` seconds if that is all the server sent. */
  readonly expires: string;
  readonly sameSite: string;
  readonly httpOnly: boolean;
  readonly secure: boolean;
}

/**
 * The Cookies tab reads the response's own `Set-Cookie` headers rather than the jar: what
 * this request was told is a different question from what the jar now holds, and the
 * former is the one you ask when a login stopped working.
 *
 * Deliberately forgiving. A malformed attribute is dropped, not an error - a cookie tab
 * that refuses to render because one server sent a stray semicolon is worse than useless.
 */
export function parseSetCookie(headers: HeaderPairs): CookieRow[] {
  const rows: CookieRow[] = [];
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== SET_COOKIE) continue;
    const row = parseOneCookie(value);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function parseOneCookie(header: string): CookieRow | null {
  const parts = header.split(COOKIE_SEPARATOR);
  const [pair, ...attributes] = parts;
  if (pair === undefined) return null;
  const split = pair.indexOf(ATTRIBUTE_SEPARATOR);
  if (split === NOT_FOUND) return null;

  let domain = ABSENT;
  let path = ABSENT;
  let expires = ABSENT;
  let sameSite = ABSENT;
  let httpOnly = false;
  let secure = false;

  for (const attribute of attributes) {
    const at = attribute.indexOf(ATTRIBUTE_SEPARATOR);
    const key = (at === NOT_FOUND ? attribute : attribute.slice(0, at)).trim().toLowerCase();
    const detail = at === NOT_FOUND ? ABSENT : attribute.slice(at + 1).trim();
    if (key === HTTP_ONLY) httpOnly = true;
    else if (key === SECURE) secure = true;
    else if (key === DOMAIN) domain = detail;
    else if (key === PATH) path = detail;
    else if (key === EXPIRES) expires = detail;
    else if (key === MAX_AGE && expires === ABSENT) expires = detail;
    else if (key === SAME_SITE) sameSite = detail;
  }

  return {
    name: pair.slice(0, split).trim(),
    value: pair.slice(split + 1).trim(),
    domain,
    path,
    expires,
    sameSite,
    httpOnly,
    secure,
  };
}

/**
 * One line of the console drawer. `side-request` and `call` rows are interleaved with the
 * logs rather than kept in their own lists so that a `pm.sendRequest` appears where it
 * happened - between the log before it and the log after it - which is the only ordering
 * that explains anything. A main call is the same argument applied to the thing that caused
 * them: without it, a five-request run is one flat stream with nothing to divide it.
 */
export type ConsoleRow =
  | {
      readonly kind: "line";
      readonly seq: number;
      readonly runId: string;
      readonly nodeId: string;
      readonly line: ConsoleLine;
    }
  | {
      readonly kind: "side-request";
      readonly seq: number;
      readonly runId: string;
      readonly nodeId: string;
      readonly summary: SideRequestSummary;
    }
  | {
      readonly kind: "call";
      readonly seq: number;
      readonly runId: string;
      readonly nodeId: string;
      /** Key into the store's `requests`; the row reads the live item itself. */
      readonly itemKey: string;
    };

/** Only the fields the merge needs, so this stays independent of `stores/runs.ts`. */
interface Stamped {
  readonly runId: string;
  readonly nodeId: string;
  readonly seq: number;
}

/** Past every real `seq`, so an exhausted stream never wins a comparison. */
const NO_SEQ = Number.POSITIVE_INFINITY;

/**
 * All three inputs are appended to in `seq` order, so this is a three-finger merge rather
 * than a concat and sort. The drawer re-derives on every console event, and a sort of 5000
 * rows per log line is the kind of thing that makes a run feel slow. A third stream does
 * not weaken that: it is still one pass over the rows it returns.
 */
export function mergeConsole(
  lines: readonly (Stamped & { readonly line: ConsoleLine })[],
  sideRequests: readonly (Stamped & { readonly summary: SideRequestSummary })[],
  calls: readonly (Stamped & { readonly itemKey: string })[],
): ConsoleRow[] {
  const rows: ConsoleRow[] = [];
  let left = 0;
  let middle = 0;
  let right = 0;
  while (left < lines.length || middle < sideRequests.length || right < calls.length) {
    const line = lines[left];
    const side = sideRequests[middle];
    const call = calls[right];
    const lineSeq = line?.seq ?? NO_SEQ;
    const sideSeq = side?.seq ?? NO_SEQ;
    const callSeq = call?.seq ?? NO_SEQ;
    if (line !== undefined && lineSeq <= sideSeq && lineSeq <= callSeq) {
      rows.push({ kind: "line", seq: line.seq, runId: line.runId, nodeId: line.nodeId, line: line.line });
      left += 1;
    } else if (side !== undefined && sideSeq <= callSeq) {
      rows.push({ kind: "side-request", seq: side.seq, runId: side.runId, nodeId: side.nodeId, summary: side.summary });
      middle += 1;
    } else if (call !== undefined) {
      rows.push({ kind: "call", seq: call.seq, runId: call.runId, nodeId: call.nodeId, itemKey: call.itemKey });
      right += 1;
    } else break;
  }
  return rows;
}

/** `http/invoke.ts` reports a response that never arrived as status zero. */
const NO_RESPONSE_STATUS = 0;

/**
 * What a side request's status column says. A `pm.sendRequest` that never got a response
 * has no code to show, and showing `0` there would read as a status rather than as the
 * absence of one, so the transport's own message takes its place.
 */
export function sideRequestStatus(summary: SideRequestSummary): string {
  return summary.statusCode === NO_RESPONSE_STATUS ? summary.message : String(summary.statusCode);
}

const MS_IN_SECOND = 1000;
const SECONDS_IN_MINUTE = 60;
const DURATION_PRECISION = 2;
const MINUTE_PRECISION = 1;

/** `1234ms` is harder to read at a glance than `1.23s`, which is the whole point of this. */
export function formatDuration(ms: number): string {
  if (ms < MS_IN_SECOND) return `${String(Math.round(ms))}ms`;
  const seconds = ms / MS_IN_SECOND;
  if (seconds < SECONDS_IN_MINUTE) return `${seconds.toFixed(DURATION_PRECISION)}s`;
  return `${(seconds / SECONDS_IN_MINUTE).toFixed(MINUTE_PRECISION)}m`;
}

/** The one timing key the runner emits. Named so a second one is a deliberate change. */
export const DURATION_KEY = "durationMs";

export function durationOf(head: ResponseHead | null): number | null {
  const ms = head?.timings[DURATION_KEY];
  return ms ?? null;
}

/** Lines of a body a console row will show before it defers to the response pane. */
export const CONSOLE_BODY_LINES = 12;
/** And a character cap, because a minified JSON body is one line of a quarter of a megabyte. */
export const CONSOLE_BODY_CHARS = 2000;
const NEWLINE = "\n";
const NO_LINES = 0;
const TEXT_START = 0;
const EMPTY_TEXT = "";

export interface ClampedBody {
  readonly text: string;
  readonly shownLines: number;
  readonly totalLines: number;
  readonly clamped: boolean;
}

/**
 * As much of a body as a 28px-collapsed console row is allowed to grow to show.
 *
 * Two caps and not one: a line cap alone lets a minified JSON response through as a single
 * line of a quarter of a megabyte, which is the row that makes the drawer stop scrolling.
 */
export function clampBody(text: string): ClampedBody {
  if (text === EMPTY_TEXT) {
    return { text: EMPTY_TEXT, shownLines: NO_LINES, totalLines: NO_LINES, clamped: false };
  }
  const lines = text.split(NEWLINE);
  const kept = lines.slice(TEXT_START, CONSOLE_BODY_LINES).join(NEWLINE);
  const trimmed = kept.length > CONSOLE_BODY_CHARS ? kept.slice(TEXT_START, CONSOLE_BODY_CHARS) : kept;
  return {
    text: trimmed,
    shownLines: trimmed.split(NEWLINE).length,
    totalLines: lines.length,
    clamped: trimmed.length < text.length,
  };
}

/** Characters were cut but no whole line was, so a line count would say nothing. */
const SHOW_WHOLE_BODY = "Show the whole body";

/**
 * What the control under a clamped body says.
 *
 * Names what pressing it gets you. The old `12 of 17 lines` was a statement of fact wearing a
 * button's clothes, which is why it read as the console refusing rather than offering.
 */
export function showAllLabel(clamped: ClampedBody): string {
  if (clamped.shownLines >= clamped.totalLines) return SHOW_WHOLE_BODY;
  return `Show all ${clamped.totalLines.toLocaleString()} lines`;
}

/**
 * What a call row's status column says. Mirrors `sideRequestStatus`: a call that never got a
 * response has no code, and `0` there would read as one rather than as the absence of one.
 */
export function callStatus(head: ResponseHead | null): string | null {
  return head === null ? null : statusText(head.status);
}
