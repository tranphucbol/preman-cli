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

const CONSOLE_MAX_LINES = 5000;
const NO_ACTIVE_RUN = null;

/* The sandbox's own shapes. Pulled off `RunEvent` rather than re-exported from core so the
 * protocol stays the only thing the renderer imports, and so these cannot drift from the wire. */
type ConsoleLine = Extract<RunEvent, { type: "console" }>["line"];
type TestResult = Extract<RunEvent, { type: "test" }>["result"];
type SideRequestSummary = Extract<RunEvent, { type: "side-request" }>["summary"];
type ResponseHead = Omit<Extract<RunEvent, { type: "response-head" }>, "type" | "runId" | "nodeId">;
type ResponseBody = Omit<Extract<RunEvent, { type: "response-body" }>, "type" | "runId" | "nodeId">;

export type RequestStatus = "running" | "done";

/** One request inside a run. In a collection run there is one of these per item per iteration. */
export interface RequestRun {
  readonly runId: string;
  readonly nodeId: string;
  readonly name: string;
  readonly iteration: number;
  readonly status: RequestStatus;
  readonly target: string | null;
  readonly sent: unknown;
  readonly head: ResponseHead | null;
  readonly body: ResponseBody | null;
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

/** A request appears once per iteration, so the iteration has to be part of the key. */
function itemKey(nodeId: string, iteration: number): string {
  return `${nodeId}#${String(iteration)}`;
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
  clearConsole: () => void;
  clear: () => void;
}

export const useRunsStore = create<RunsState>((set) => ({
  runs: new Map(),
  requests: new Map(),
  openItems: new Map(),
  console: [],
  sideRequests: [],
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
            items: [],
          });
          return { runs, activeRunId: event.runId, activeItemKey: null };
        }

        case "request-start": {
          const key = itemKey(event.nodeId, event.iteration);
          const requests = new Map(state.requests);
          requests.set(key, {
            runId: event.runId,
            nodeId: event.nodeId,
            name: event.name,
            iteration: event.iteration,
            status: "running",
            target: null,
            sent: undefined,
            head: null,
            body: null,
            tests: [],
            exitCode: null,
            returnCode: null,
          });
          const runs = new Map(state.runs);
          const run = runs.get(event.runId);
          if (run !== undefined) runs.set(event.runId, { ...run, items: [...run.items, key] });
          const openItems = new Map(state.openItems);
          openItems.set(openKey(event.runId, event.nodeId), key);
          // A single-request run focuses itself, so sending shows the response without a click.
          const focus = state.activeItemKey === null ? key : state.activeItemKey;
          return { requests, runs, openItems, activeItemKey: focus };
        }

        case "console": {
          const entry = { runId: event.runId, nodeId: event.nodeId, seq: state.nextSeq, line: event.line };
          const next = [...state.console, entry];
          // Capped rather than unbounded: a script in a loop must not be able to exhaust the heap.
          return { console: next.slice(-CONSOLE_MAX_LINES), nextSeq: state.nextSeq + 1 };
        }

        case "side-request": {
          const entry = { runId: event.runId, nodeId: event.nodeId, seq: state.nextSeq, summary: event.summary };
          return { sideRequests: [...state.sideRequests, entry], nextSeq: state.nextSeq + 1 };
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

  clearConsole() {
    set({ console: [], sideRequests: [] });
  },

  clear() {
    set({
      runs: new Map(),
      requests: new Map(),
      openItems: new Map(),
      console: [],
      sideRequests: [],
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
  { type: "request-sent" | "response-head" | "response-body" | "test" | "request-end" }
>;

function applyToItem(state: RunsState, event: ItemEvent): Partial<RunsState> {
  const key = state.openItems.get(openKey(event.runId, event.nodeId));
  if (key === undefined) return {};
  const item = state.requests.get(key);
  if (item === undefined) return {};

  const requests = new Map(state.requests);
  switch (event.type) {
    case "request-sent":
      requests.set(key, { ...item, target: event.target, sent: event.sent });
      break;
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
    case "test":
      requests.set(key, { ...item, tests: [...item.tests, event.result] });
      break;
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

/** The most recent run for a node, which is what a request tab's own response pane shows. */
export function useLatestRunFor(nodeId: string): RequestRun | undefined {
  return useRunsStore((state) => {
    let latest: RequestRun | undefined;
    for (const item of state.requests.values()) if (item.nodeId === nodeId) latest = item;
    return latest;
  });
}
