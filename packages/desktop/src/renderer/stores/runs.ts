/**
 * What a run has told us so far.
 *
 * The rule attached to this store: it never holds a response body. It holds a handle, a byte count
 * and a preview, and the viewer asks the engine for windows as it scrolls. That is the difference
 * between a 50MB response costing 50MB of renderer heap and costing nothing.
 *
 * Everything here is assembled from `RunEvent`s as they arrive, so a 30-assertion script fills its
 * Tests tab while it runs instead of after.
 */
import { create } from "zustand";

import type { EngineError, ExitCode, RunEvent } from "@preman/desktop/engine/protocol.js";
import { addTest, NO_TESTS } from "@preman/desktop/renderer/model/response.js";
import type {
  ConsoleLine,
  ResponseBody,
  ResponseFailure,
  ResponseHead,
  SentRequest,
  SideRequestSummary,
  TestResult,
  TestTotals,
} from "@preman/desktop/renderer/model/response.js";

/** A script in a loop must not be able to exhaust the heap. */
export const CONSOLE_MAX_LINES = 5000;
const NO_ACTIVE_RUN = null;
/** Iterations are zero-based on the wire; a run has entered one iteration the moment it starts. */
const SINGLE_ITERATION = 1;

export type RequestStatus = "running" | "done";

/** One request inside a run. In a collection run there is one of these per item per iteration. */
export interface RequestRun {
  readonly runId: string;
  readonly nodeId: string;
  readonly name: string;
  readonly iteration: number;
  readonly status: RequestStatus;
  readonly target: string | null;
  readonly sent: SentRequest | null;
  readonly head: ResponseHead | null;
  readonly body: ResponseBody | null;
  /** Set instead of `body` when the transport produced nothing to inspect. */
  readonly failure: ResponseFailure | null;
  readonly tests: readonly TestResult[];
  readonly exitCode: ExitCode | null;
  readonly returnCode: string | null;
}

/** A whole run: one request, or a collection. */
export interface Run {
  readonly runId: string;
  readonly total: number;
  readonly done: boolean;
  readonly cancelled: boolean;
  readonly exitCode: ExitCode | null;
  readonly warnings: readonly string[];
  readonly error: EngineError | null;
  /**
   * How many iterations have actually been entered. One until an event proves otherwise, which is
   * what lets the runner label rows `#2` only when there is a `#1` to distinguish them from.
   * Derived rather than taken from the options: with a data file and no explicit count, core
   * decides the number from the rows, so what was asked for is not what happened.
   */
  readonly iterations: number;
  /**
   * Every assertion in the run, counted as its event arrives.
   *
   * Accumulated rather than folded over `items` on read. A summary that re-scanned every item on
   * every `test` event would be quadratic in the length of the run, and — because a store selector
   * that builds an object returns a new reference every time it is called — it would also spin
   * React until it gave up.
   */
  readonly tests: TestTotals;
  /** Keys into `requests`, in arrival order, so the runner's live list needs no sorting. */
  readonly items: readonly string[];
}

/** A console line tagged with where it came from, so the drawer can group by request. */
export interface ConsoleEntry {
  readonly runId: string;
  readonly nodeId: string;
  readonly seq: number;
  readonly line: ConsoleLine;
}

export interface SideRequestEntry {
  readonly runId: string;
  readonly nodeId: string;
  readonly seq: number;
  readonly summary: SideRequestSummary;
}

/**
 * A main call's position in the console, and nothing else.
 *
 * A reference rather than a copy: a call mutates three times - sent, head, body - and copying it
 * into the console stream would replace the array on every response event, re-running the merge
 * over every row in the run. The row reads the item itself through `useRequestItem`.
 */
export interface CallEntry {
  readonly runId: string;
  readonly nodeId: string;
  readonly seq: number;
  readonly itemKey: string;
}

/**
 * A request appears once per iteration, so the iteration has to be part of the key - and once
 * per run, so the run does too.
 *
 * The run is the part that is easy to leave out and expensive to leave out. Nothing here is
 * cleared between sends, so pressing Send twice on one request produces two console rows; if
 * both rows named the same item, the second `request-start` would overwrite the first row's
 * response, and one caret would open both. That is two bugs from one missing field.
 */
export function itemKeyFor(runId: string, nodeId: string, iteration: number): string {
  return `${runId}\u0000${nodeId}#${String(iteration)}`;
}

/**
 * Only `request-start` carries the iteration, so every later event for that request has to be told
 * which item it belongs to. A run executes one request at a time, so remembering the open item per
 * run is exact, and O(1) rather than a scan.
 */
function openKey(runId: string, nodeId: string): string {
  return `${runId}\u0000${nodeId}`;
}

export interface RunsState {
  runs: Map<string, Run>;
  requests: Map<string, RequestRun>;
  /** `openKey(runId, nodeId)` to the `itemKey` currently receiving that request's events. */
  openItems: Map<string, string>;
  console: ConsoleEntry[];
  sideRequests: SideRequestEntry[];
  /** Where each main call sits in the console's arrival order. */
  calls: CallEntry[];
  /** The `itemKey`s of the call rows the reader has opened. */
  expandedCalls: Set<string>;
  /** The run the response pane is showing. */
  activeRunId: string | null;
  /** The item within `activeRunId` the response pane is showing. */
  activeItemKey: string | null;
  nextSeq: number;

  // Function properties rather than method signatures: these are read off the state object and
  // handed to event handlers, and none of them uses `this`.
  apply: (event: RunEvent) => void;
  /** The engine's terminal signal. `run-end` cannot be relied on: a bad selector never emits one. */
  finish: (runId: string, outcome: { warnings: readonly string[]; cancelled: boolean; error?: EngineError }) => void;
  focus: (runId: string, key: string) => void;
  toggleCall: (itemKey: string) => void;
  clearConsole: () => void;
  clear: () => void;
}

export const useRunsStore = create<RunsState>((set) => ({
  runs: new Map(),
  requests: new Map(),
  openItems: new Map(),
  console: [],
  sideRequests: [],
  calls: [],
  expandedCalls: new Set(),
  activeRunId: NO_ACTIVE_RUN,
  activeItemKey: null,
  nextSeq: 0,

  apply(event) {
    set((state) => {
      switch (event.type) {
        case "run-start": {
          const runs = new Map(state.runs);
          runs.set(event.runId, {
            runId: event.runId,
            total: event.total,
            done: false,
            cancelled: false,
            exitCode: null,
            warnings: [],
            error: null,
            iterations: SINGLE_ITERATION,
            tests: NO_TESTS,
            items: [],
          });
          return { runs, activeRunId: event.runId, activeItemKey: null };
        }

        case "request-start": {
          const key = itemKeyFor(event.runId, event.nodeId, event.iteration);
          const requests = new Map(state.requests);
          requests.set(key, {
            runId: event.runId,
            nodeId: event.nodeId,
            name: event.name,
            iteration: event.iteration,
            status: "running",
            target: null,
            sent: null,
            head: null,
            failure: null,
            body: null,
            tests: [],
            exitCode: null,
            returnCode: null,
          });
          const runs = new Map(state.runs);
          const run = runs.get(event.runId);
          if (run !== undefined) {
            runs.set(event.runId, {
              ...run,
              iterations: Math.max(run.iterations, event.iteration + SINGLE_ITERATION),
              items: [...run.items, key],
            });
          }
          const openItems = new Map(state.openItems);
          openItems.set(openKey(event.runId, event.nodeId), key);
          // A single-request run focuses itself, so sending shows the response without a click.
          const focus = state.activeItemKey === null ? key : state.activeItemKey;
          return { requests, runs, openItems, activeItemKey: focus };
        }

        case "console": {
          const entry = { runId: event.runId, nodeId: event.nodeId, seq: state.nextSeq, line: event.line };
          const next = [...state.console, entry];
          return { console: next.slice(-CONSOLE_MAX_LINES), nextSeq: state.nextSeq + 1 };
        }

        case "side-request": {
          const entry = { runId: event.runId, nodeId: event.nodeId, seq: state.nextSeq, summary: event.summary };
          const next = [...state.sideRequests, entry];
          // Capped for the same reason as `console`, and separately: a script that only ever
          // calls `pm.sendRequest` logs nothing, so the console's cap would never save it.
          return { sideRequests: next.slice(-CONSOLE_MAX_LINES), nextSeq: state.nextSeq + 1 };
        }

        case "run-end": {
          const runs = new Map(state.runs);
          const run = runs.get(event.runId);
          if (run === undefined) return {};
          runs.set(event.runId, { ...run, exitCode: event.exitCode });
          return { runs };
        }

        default:
          return applyToItem(state, event);
      }
    });
  },

  finish(runId, outcome) {
    set((state) => {
      const runs = new Map(state.runs);
      const run = runs.get(runId);
      if (run === undefined) return {};
      runs.set(runId, {
        ...run,
        done: true,
        cancelled: outcome.cancelled,
        warnings: [...outcome.warnings],
        error: outcome.error ?? null,
      });
      // A run that failed before its first request still has to stop looking like it is running.
      const requests = new Map(state.requests);
      for (const key of run.items) {
        const item = requests.get(key);
        if (item?.status === "running") requests.set(key, { ...item, status: "done" });
      }
      return { runs, requests };
    });
  },

  focus(runId, key) {
    set({ activeRunId: runId, activeItemKey: key });
  },

  toggleCall(itemKey) {
    set((state) => {
      const expandedCalls = new Set(state.expandedCalls);
      if (expandedCalls.has(itemKey)) expandedCalls.delete(itemKey);
      else expandedCalls.add(itemKey);
      return { expandedCalls };
    });
  },

  clearConsole() {
    // All three streams, and the expansion set with them: a cleared console that kept its
    // expanded keys would bring those rows back open on the next call with the same key.
    set({ console: [], sideRequests: [], calls: [], expandedCalls: new Set() });
  },

  clear() {
    set({
      runs: new Map(),
      requests: new Map(),
      openItems: new Map(),
      console: [],
      sideRequests: [],
      calls: [],
      expandedCalls: new Set(),
      activeRunId: NO_ACTIVE_RUN,
      activeItemKey: null,
      nextSeq: 0,
    });
  },
}));

/**
 * The per-request events, which all need the same lookup. Split out of `apply` so the switch there
 * stays readable and so "which events touch one item" is answerable by reading one function.
 */
type ItemEvent = Extract<
  RunEvent,
  { type: "request-sent" | "response-head" | "response-body" | "response-failure" | "test" | "request-end" }
>;

function applyToItem(state: RunsState, event: ItemEvent): Partial<RunsState> {
  const key = state.openItems.get(openKey(event.runId, event.nodeId));
  if (key === undefined) return {};
  const item = state.requests.get(key);
  if (item === undefined) return {};

  const requests = new Map(state.requests);
  switch (event.type) {
    case "request-sent": {
      requests.set(key, { ...item, target: event.target, sent: event.sent });
      // The one per-request event that mints a `seq`, and it is this one rather than
      // `request-start` or `request-end`: at the start there is no target to show, and at the
      // end the row would sort below the pre-request logs it caused.
      const calls = [...state.calls, { runId: event.runId, nodeId: event.nodeId, seq: state.nextSeq, itemKey: key }];
      // Capped for the same reason as `console`, and separately: a run that logs nothing would
      // never trip the console's own cap.
      return { requests, calls: calls.slice(-CONSOLE_MAX_LINES), nextSeq: state.nextSeq + 1 };
    }
    case "response-head":
      requests.set(key, { ...item, head: { status: event.status, headers: event.headers, timings: event.timings } });
      break;
    case "response-body":
      requests.set(key, {
        ...item,
        body: {
          handle: event.handle,
          byteLength: event.byteLength,
          contentType: event.contentType,
          preview: event.preview,
          truncated: event.truncated,
        },
      });
      break;
    case "response-failure":
      requests.set(key, {
        ...item,
        failure: {
          stage: event.stage,
          message: event.message,
          details: event.details,
          trailers: event.trailers,
        },
      });
      break;
    case "test": {
      requests.set(key, { ...item, tests: [...item.tests, event.result] });
      // The run's own totals ride along, so the summary reads two numbers instead of folding over
      // every item each time an assertion lands.
      const runs = new Map(state.runs);
      const run = runs.get(event.runId);
      if (run === undefined) return { requests };
      runs.set(event.runId, { ...run, tests: addTest(run.tests, event.result) });
      return { requests, runs };
    }
    case "request-end": {
      requests.set(key, {
        ...item,
        status: "done",
        exitCode: event.exitCode,
        returnCode: event.returnCode ?? null,
      });
      // The request is over, so nothing else can belong to it. Releasing the key here means a
      // late event from a run the engine already abandoned lands nowhere instead of on this item.
      const openItems = new Map(state.openItems);
      openItems.delete(openKey(event.runId, event.nodeId));
      return { requests, openItems };
    }
  }
  return { requests };
}

/** The subscription the response pane makes: one item, not the map. */
export function useFocusedRequest(): RequestRun | undefined {
  return useRunsStore((state) => (state.activeItemKey === null ? undefined : state.requests.get(state.activeItemKey)));
}

export function useActiveRun(): Run | undefined {
  return useRunsStore((state) => (state.activeRunId === null ? undefined : state.runs.get(state.activeRunId)));
}

/** One named run, for a pane that started it and is watching that one rather than the latest. */
export function useRun(runId: string | null): Run | undefined {
  return useRunsStore((state) => (runId === null ? undefined : state.runs.get(runId)));
}

/**
 * One item of a run, by the key `Run.items` holds.
 *
 * The subscription a runner row is allowed to make, for the same reason the sidebar has `useNode`:
 * a five-thousand-item run must repaint the row that changed, not the list.
 */
export function useRequestItem(key: string): RequestRun | undefined {
  return useRunsStore((state) => state.requests.get(key));
}

/**
 * Whether a call row is open. A separate subscription so toggling one row repaints one row.
 *
 * Store state rather than row-local `useState`, mirroring `catalog.collapsed` but named for the
 * opposite default: the console's virtualizer unmounts off-screen rows, so a row that remembered
 * its own expansion would silently collapse the moment it scrolled away.
 */
export function useCallExpanded(itemKey: string): boolean {
  return useRunsStore((state) => state.expandedCalls.has(itemKey));
}

/** Whether a run's focused item is this one, so a row can highlight without reading the map. */
export function useIsFocusedItem(key: string): boolean {
  return useRunsStore((state) => state.activeItemKey === key);
}

/** The most recent run for a node, which is what a request tab's own response pane shows. */
export function useLatestRunFor(nodeId: string): RequestRun | undefined {
  return useRunsStore((state) => {
    let latest: RequestRun | undefined;
    for (const item of state.requests.values()) if (item.nodeId === nodeId) latest = item;
    return latest;
  });
}
