/**
 * What came back.
 *
 * One row of chrome - the sub-tabs on the left, the status, time and size on the right -
 * and then whichever view the reader asked for. Everything is assembled from `RunEvent`s as
 * they arrive, so the Tests tab fills in while a thirty-assertion script is still running
 * rather than after it finishes.
 *
 * The pane subscribes to one request rather than to the run, so a collection run of five
 * thousand items does not re-render it five thousand times.
 */
import * as Tabs from "@radix-ui/react-tabs";
import { useState, type ReactNode } from "react";

import {
  durationOf,
  exitLabel,
  exitTone,
  formatDuration,
  isCleanExit,
  parseSetCookie,
  testTone,
  testTotals,
  toneClass,
  type HeaderPairs,
  type SentRequest,
  type TestResult,
} from "@preman/desktop/renderer/model/response.js";
import { formatBytes } from "@preman/desktop/renderer/model/body.js";
import { useLatestRunFor, type RequestRun } from "@preman/desktop/renderer/stores/runs.js";
import { CodeEditor } from "@preman/desktop/renderer/ui/CodeEditor.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { StatusTag } from "@preman/desktop/renderer/ui/StatusTag.js";

import { BodyViewer } from "./BodyViewer.js";
import { ResponseFailure } from "./ResponseFailure.js";

const TABS = ["body", "headers", "cookies", "tests", "timeline"] as const;
type ResponseTab = (typeof TABS)[number];
const DEFAULT_TAB: ResponseTab = "body";

const TAB_LABEL: Record<ResponseTab, string> = {
  body: "Body",
  headers: "Headers",
  cookies: "Cookies",
  tests: "Tests",
  timeline: "Timeline",
};

const TRIGGER_CLASS =
  "h-tab shrink-0 border-b-2 border-transparent px-2.5 text-xs text-ink-dim hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink";

const JSON_INDENT = 2;
const NOTHING_SENT = "";
const EMPTY_ROWS = 0;

const IDLE_HINT = "Send this request to see the response.";
const RUNNING_HINT = "Running…";
const NO_HEADERS_HINT = "The response carried no headers.";
const NO_COOKIES_HINT = "The response set no cookies.";
const NO_TESTS_HINT = "This request ran no assertions.";
const NO_BODY_HINT = "This request returned no body.";

export function ResponsePane({ nodeId }: { readonly nodeId: string }) {
  const run = useLatestRunFor(nodeId);
  return <ResponseView run={run} />;
}

/**
 * The same pane over a run somebody else chose.
 *
 * The collection runner focuses one item at a time out of thousands, so it holds the
 * subscription itself and hands the result down. Splitting the view from the subscription is
 * what lets both callers paint identically without the runner going through `nodeId`, which
 * for an iterated run would not identify a single response.
 */
export function ResponseView({ run }: { readonly run: RequestRun | undefined }) {
  const [tab, setTab] = useState<ResponseTab>(DEFAULT_TAB);

  if (run === undefined) return <Hint>{IDLE_HINT}</Hint>;

  return (
    <Tabs.Root
      value={tab}
      onValueChange={(next) => {
        setTab(next as ResponseTab);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 items-center border-b border-line pr-2">
        <Tabs.List className="flex min-w-0 flex-1 items-center overflow-x-auto px-1">
          {TABS.map((each) => (
            <Tabs.Trigger key={each} value={each} className={TRIGGER_CLASS}>
              {TAB_LABEL[each]}
              {each === "tests" && run.tests.length > EMPTY_ROWS && (
                <span className="ml-1 text-ink-faint">{String(run.tests.length)}</span>
              )}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Summary run={run} />
      </div>

      <Pane value="body">
        {run.failure !== null ? (
          // A failed call has no body, and "no body" is not a report of what went wrong.
          <ResponseFailure status={run.head?.status} failure={run.failure} />
        ) : run.body === null ? (
          <Hint>{run.status === "running" ? RUNNING_HINT : NO_BODY_HINT}</Hint>
        ) : (
          // Keyed on the handle so a new response gets a new viewer rather than a reset one.
          // A viewer that reset itself in an effect would paint the old body for one frame.
          <BodyViewer key={run.body.handle} body={run.body} />
        )}
      </Pane>

      <Pane value="headers">
        <Headers headers={run.head?.headers ?? []} />
      </Pane>

      <Pane value="cookies">
        <Cookies headers={run.head?.headers ?? []} />
      </Pane>

      <Pane value="tests">
        <TestList tests={run.tests} />
      </Pane>

      <Pane value="timeline">
        <Timeline run={run} />
      </Pane>
    </Tabs.Root>
  );
}

/** Every sub-tab is a scrolling column, so the wrapper is written once. */
function Pane({ value, children }: { readonly value: ResponseTab; readonly children: ReactNode }) {
  return (
    <Tabs.Content value={value} className="flex min-h-0 flex-1 flex-col focus:outline-none">
      {children}
    </Tabs.Content>
  );
}

function Hint({ children }: { readonly children: ReactNode }) {
  return <p className="p-gutter text-xs text-ink-faint">{children}</p>;
}

/**
 * Status, time and size, which is the one line people actually read.
 *
 * A gRPC status arrives as its code name and an HTTP one as a number, so this needs no idea
 * which protocol it is showing. `returnCode` only ever comes from the gRPC path, so it
 * appears when it exists rather than being asked for.
 */
function Summary({ run }: { readonly run: RequestRun }) {
  const status = run.head?.status;
  const ms = durationOf(run.head);
  return (
    <div className="flex shrink-0 items-center gap-2.5 text-2xs">
      {run.status === "running" && <span className="text-ink-faint">{RUNNING_HINT}</span>}
      {status !== undefined && <StatusTag status={status} />}
      {run.returnCode !== null && (
        <span className="font-mono text-ink-dim">
          return_code <span className="text-ink">{run.returnCode}</span>
        </span>
      )}
      {ms !== null && <span className="text-ink-dim">{formatDuration(ms)}</span>}
      {run.body !== null && <span className="text-ink-dim">{formatBytes(run.body.byteLength)}</span>}
      {run.exitCode !== null && !isCleanExit(run.exitCode) && (
        <span className={toneClass(exitTone(run.exitCode))}>{exitLabel(run.exitCode)}</span>
      )}
    </div>
  );
}

function Headers({ headers }: { readonly headers: HeaderPairs }) {
  if (headers.length === EMPTY_ROWS) return <Hint>{NO_HEADERS_HINT}</Hint>;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {headers.map(([name, value], index) => (
        <div key={`${name}:${String(index)}`} className="flex items-start gap-3 border-b border-line px-2 py-1.5">
          <span className="w-52 shrink-0 font-mono text-2xs break-all text-ink-dim">{name}</span>
          <span className="min-w-0 font-mono text-2xs break-all text-ink">{value}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * The response's own `Set-Cookie` headers, not the jar. What this request was told is a
 * different question from what the jar now holds, and it is the one you ask when a login
 * stopped working.
 */
function Cookies({ headers }: { readonly headers: HeaderPairs }) {
  const cookies = parseSetCookie(headers);
  if (cookies.length === EMPTY_ROWS) return <Hint>{NO_COOKIES_HINT}</Hint>;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      {cookies.map((cookie, index) => (
        <div key={`${cookie.name}:${String(index)}`} className="border-b border-line px-2 py-1.5">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-2xs text-ink">{cookie.name}</span>
            <span className="min-w-0 truncate font-mono text-2xs text-ink-dim">{cookie.value}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-x-3 text-2xs text-ink-faint">
            {cookie.domain !== "" && <span>domain {cookie.domain}</span>}
            {cookie.path !== "" && <span>path {cookie.path}</span>}
            {cookie.expires !== "" && <span>expires {cookie.expires}</span>}
            {cookie.sameSite !== "" && <span>samesite {cookie.sameSite}</span>}
            {cookie.httpOnly && <span>httponly</span>}
            {cookie.secure && <span>secure</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function TestList({ tests }: { readonly tests: readonly TestResult[] }) {
  if (tests.length === EMPTY_ROWS) return <Hint>{NO_TESTS_HINT}</Hint>;
  const totals = testTotals(tests);
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <div className="flex items-center gap-3 border-b border-line px-2 py-1.5 text-2xs">
        <span className="text-ok">{String(totals.passed)} passed</span>
        {totals.failed > EMPTY_ROWS && <span className="text-danger">{String(totals.failed)} failed</span>}
        {totals.skipped > EMPTY_ROWS && <span className="text-ink-faint">{String(totals.skipped)} skipped</span>}
      </div>
      {tests.map((test, index) => (
        <div key={`${test.name}:${String(index)}`} className="border-b border-line px-2 py-1.5">
          <div className="flex items-baseline gap-2">
            <span className={cn("w-14 shrink-0 text-2xs", toneClass(testTone(test.status)))}>{test.status}</span>
            <span className="min-w-0 text-xs text-ink">{test.name}</span>
            <span className="ml-auto shrink-0 text-2xs text-ink-faint">{test.origin.label}</span>
          </div>
          {test.error !== undefined && (
            <p className="mt-0.5 pl-16 font-mono text-2xs break-words text-danger">{test.error}</p>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * What was sent and how it went.
 *
 * `target` is the runner's own label - `grpc://authority/Method` or `GET https://…` - so
 * this pane needs no idea which protocol produced it. `sent` is the gRPC message, or the
 * HTTP method, url, headers and body, whichever the runner built.
 */
function Timeline({ run }: { readonly run: RequestRun }) {
  const ms = durationOf(run.head);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <dl className="shrink-0 border-b border-line px-2 py-1.5 text-2xs">
        <Entry label="target">{run.target ?? "not resolved"}</Entry>
        {ms !== null && <Entry label="duration">{formatDuration(ms)}</Entry>}
        {run.exitCode !== null && <Entry label="outcome">{exitLabel(run.exitCode)}</Entry>}
        {run.returnCode !== null && <Entry label="return_code">{run.returnCode}</Entry>}
        <Entry label="iteration">{String(run.iteration)}</Entry>
      </dl>
      <CodeEditor value={sentText(run.sent)} language="json" readOnly placeholder="Nothing was sent." />
    </div>
  );
}

function Entry({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-ink-faint">{label}</dt>
      <dd className="min-w-0 font-mono break-all text-ink-dim">{children}</dd>
    </div>
  );
}

/**
 * The payload, not the envelope. `protocol` is a discriminator for whoever reads the event;
 * dumping it here would put a key in the Request tab that was never sent.
 */
function sentText(sent: SentRequest | null): string {
  if (sent === null) return NOTHING_SENT;
  const payload =
    sent.protocol === "grpc"
      ? sent.message
      : { method: sent.method, url: sent.url, headers: sent.headers, body: sent.body };
  return JSON.stringify(payload, null, JSON_INDENT) ?? NOTHING_SENT;
}
