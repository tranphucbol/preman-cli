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
import { EXIT_CODES, type ExitCode, type RunEvent } from "@preman/desktop/engine/protocol.js";

/* The sandbox's and the transport's own shapes, as they arrive. */
export type ConsoleLine = Extract<RunEvent, { type: "console" }>["line"];
export type ConsoleLevel = ConsoleLine["level"];
export type TestResult = Extract<RunEvent, { type: "test" }>["result"];
export type TestStatus = TestResult["status"];
export type SideRequestSummary = Extract<RunEvent, { type: "side-request" }>["summary"];
export type ResponseHead = Omit<Extract<RunEvent, { type: "response-head" }>, "type" | "runId" | "nodeId">;
export type ResponseBody = Omit<Extract<RunEvent, { type: "response-body" }>, "type" | "runId" | "nodeId">;
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

const HTTP_SUCCESS_MIN = 200;
const HTTP_REDIRECT_MIN = 300;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;
/** gRPC statuses arrive as their code name, and exactly one of them is success. */
const GRPC_OK = "OK";

/**
 * A gRPC status is a string, an HTTP status is a number, and `response-head` carries
 * whichever the transport produced. Redirects read neutral rather than ok: the engine
 * follows them itself, so a 3xx that survived to the pane means the chain stopped there.
 */
export function statusTone(status: number | string): Tone {
  if (typeof status === "string") return status === GRPC_OK ? "ok" : "danger";
  if (status >= HTTP_SERVER_ERROR_MIN) return "danger";
  if (status >= HTTP_CLIENT_ERROR_MIN) return "warn";
  if (status >= HTTP_SUCCESS_MIN && status < HTTP_REDIRECT_MIN) return "ok";
  return "neutral";
}

export function statusText(status: number | string): string {
  return typeof status === "string" ? status : String(status);
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
 * One line of the console drawer. `side-request` rows are interleaved rather than kept in
 * their own list so that a `pm.sendRequest` appears where it happened - between the log
 * before it and the log after it - which is the only ordering that explains anything.
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
    };

/** Only the fields the merge needs, so this stays independent of `stores/runs.ts`. */
interface Stamped {
  readonly runId: string;
  readonly nodeId: string;
  readonly seq: number;
}

/**
 * Both inputs are appended to in `seq` order, so this is a two-finger merge rather than a
 * concat and sort. The drawer re-derives on every console event, and a sort of 5000 rows
 * per log line is the kind of thing that makes a run feel slow.
 */
export function mergeConsole(
  lines: readonly (Stamped & { readonly line: ConsoleLine })[],
  sideRequests: readonly (Stamped & { readonly summary: SideRequestSummary })[],
): ConsoleRow[] {
  const rows: ConsoleRow[] = [];
  let left = 0;
  let right = 0;
  while (left < lines.length || right < sideRequests.length) {
    const line = lines[left];
    const side = sideRequests[right];
    if (side === undefined || (line !== undefined && line.seq < side.seq)) {
      if (line === undefined) break;
      rows.push({ kind: "line", seq: line.seq, runId: line.runId, nodeId: line.nodeId, line: line.line });
      left += 1;
    } else {
      rows.push({ kind: "side-request", seq: side.seq, runId: side.runId, nodeId: side.nodeId, summary: side.summary });
      right += 1;
    }
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
