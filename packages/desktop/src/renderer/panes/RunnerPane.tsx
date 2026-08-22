/**
 * The collection runner.
 *
 * Four options, a live list, a summary and an export - and not one line of run semantics of its
 * own. `iterationCount`, `iterationData`, `bail` and `delayRequestMs` are the same four fields the
 * CLI's flags fill in, the outcome of the run is the one core already aggregated (a hard error
 * outranks a transport failure, which outranks a non-zero `return_code`, which outranks a failed
 * assertion - not the numerically largest code), and both report formats are rendered by the
 * engine from the outcome it already holds. A GUI that computed any of that would be a second
 * implementation to keep in step with the first.
 *
 * The list is virtualized and each row subscribes to its own item, because a fifty-request
 * collection over a hundred data rows is five thousand rows and they arrive one at a time. Clicking
 * a row focuses it, and the pane beside it is the same `ResponseView` a request tab uses: the
 * response to the eleventh iteration of one request deserves the same headers, cookies and
 * assertions as any other, and a runner with its own smaller viewer is how you end up going back
 * to the CLI to see what actually came back.
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useRef, useState } from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

import { REPORT_FORMATS, type ReportFormat } from "@preman/desktop/engine/protocol.js";

import {
  cancelRun,
  exportReport,
  pickDataFile,
  startRun,
  type Failure,
  type RunnerOptions,
} from "@preman/desktop/renderer/actions.js";
import {
  durationOf,
  exitLabel,
  exitTone,
  formatDuration,
  statusText,
  statusTone,
  testTotals,
  toneClass,
} from "@preman/desktop/renderer/model/response.js";
import { useNode } from "@preman/desktop/renderer/stores/catalog.js";
import {
  useFocusedRequest,
  useIsFocusedItem,
  useRequestItem,
  useRun,
  useRunsStore,
  type Run,
} from "@preman/desktop/renderer/stores/runs.js";
import { cn } from "@preman/desktop/renderer/ui/cn.js";
import { Button, Field, IconButton } from "@preman/desktop/renderer/ui/Controls.js";
import { CancelIcon, CloseIcon, ExportIcon, RunnerIcon, SendIcon } from "@preman/desktop/renderer/ui/icons.js";

import { ResponseView } from "./ResponsePane.js";

/** Must equal `--spacing-row` in app.css, so the virtualizer needs no measurement pass. */
const ROW_HEIGHT = 28;
const OVERSCAN = 12;

const LIST_ID = "runner-list";
const DETAIL_ID = "runner-detail";
const RUNNER_LAYOUT_ID = "preman:runner";
/** Strings without units are percentages in react-resizable-panels v4. */
const LIST_DEFAULT = "38";
const LIST_MIN = "20";
const DETAIL_MIN = "25";

/** Absent, not one: with a data file and no explicit count, core takes the count from the rows. */
const ITERATIONS_AUTO = null;
const NO_DELAY_MS = 0;
/** Iterations are zero-based on the wire, so a row's ordinal is its iteration plus one. */
const SINGLE_ITERATION = 1;
const EMPTY = "";
const NOTHING = 0;

const FORMAT_LABEL: Record<ReportFormat, string> = { json: "JSON", junit: "JUnit" };

const IDLE_HINT = "Nothing has run yet.";
const NOT_RUNNABLE_HINT = "Only a collection or a folder can be run.";
const DATA_HINT = "One iteration per row";
const ITERATIONS_PLACEHOLDER = "auto";

export function RunnerPane({
  nodeId,
  onDismiss,
}: {
  readonly nodeId: string;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  const node = useNode(nodeId);
  const [runId, setRunId] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [iterationCount, setIterationCount] = useState<number | null>(ITERATIONS_AUTO);
  const [iterationData, setIterationData] = useState<string | null>(null);
  const [bail, setBail] = useState(false);
  const [delayRequestMs, setDelayRequestMs] = useState(NO_DELAY_MS);

  const run = useRun(runId);
  const running = run !== undefined && !run.done;

  const start = useCallback(async (): Promise<void> => {
    const options: RunnerOptions = { iterationCount, iterationData, bail, delayRequestMs };
    const result = await startRun(nodeId, options);
    if (!result.ok) {
      setFailure(result.failure);
      return;
    }
    setFailure(null);
    setRunId(result.value);
  }, [nodeId, iterationCount, iterationData, bail, delayRequestMs]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-tab shrink-0 items-center gap-2 border-b border-line px-gutter">
        <span className="text-glyph">
          <RunnerIcon />
        </span>
        <span className="truncate text-xs font-medium text-ink">{node?.name ?? nodeId}</span>
        <div className="flex-1" />
        {REPORT_FORMATS.map((format) => (
          <Button
            key={format}
            variant="quiet"
            disabled={run === undefined || !run.done}
            onClick={() => {
              void exportReport(runId ?? EMPTY, format).then((result) => {
                setFailure(result.ok ? null : result.failure);
              });
            }}
          >
            <ExportIcon />
            {FORMAT_LABEL[format]}
          </Button>
        ))}
        <IconButton label="Close runner" onClick={onDismiss}>
          <CloseIcon />
        </IconButton>
      </div>

      <Options
        iterationCount={iterationCount}
        iterationData={iterationData}
        bail={bail}
        delayRequestMs={delayRequestMs}
        running={running}
        runnable={node !== undefined && node.kind !== "request"}
        onIterationCount={setIterationCount}
        onIterationData={setIterationData}
        onBail={setBail}
        onDelay={setDelayRequestMs}
        onRun={() => {
          void start();
        }}
        onCancel={() => {
          if (runId !== null) void cancelRun(runId).then(setFailure);
        }}
      />

      {failure !== null && (
        <div role="alert" className="shrink-0 border-b border-danger/30 bg-danger/10 px-gutter py-1.5">
          <p className="text-xs text-danger">{failure.message}</p>
          {failure.details.map((detail) => (
            <p key={detail} className="text-2xs text-ink-dim">
              {detail}
            </p>
          ))}
        </div>
      )}

      {run === undefined ? (
        <p className="p-gutter text-xs text-ink-faint">
          {node !== undefined && node.kind === "request" ? NOT_RUNNABLE_HINT : IDLE_HINT}
        </p>
      ) : (
        <>
          <Summary run={run} />
          <Exchange run={run} />
        </>
      )}
    </div>
  );
}

/**
 * The four options, on one row.
 *
 * Controlled rather than uncontrolled, which is the opposite of the request grid's rule and for
 * the opposite reason: four controls whose values are read by a button beside them, not forty
 * cells writing into a store. An iterations box that only committed on blur would run the old
 * count for anyone who typed and clicked straight through.
 */
function Options({
  iterationCount,
  iterationData,
  bail,
  delayRequestMs,
  running,
  runnable,
  onIterationCount,
  onIterationData,
  onBail,
  onDelay,
  onRun,
  onCancel,
}: {
  readonly iterationCount: number | null;
  readonly iterationData: string | null;
  readonly bail: boolean;
  readonly delayRequestMs: number;
  readonly running: boolean;
  readonly runnable: boolean;
  readonly onIterationCount: (value: number | null) => void;
  readonly onIterationData: (value: string | null) => void;
  readonly onBail: (value: boolean) => void;
  readonly onDelay: (value: number) => void;
  readonly onRun: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-gutter py-1.5">
      <label className="flex items-center gap-1.5 text-2xs text-ink-dim">
        Iterations
        <span className="w-16">
          <Field
            type="number"
            min={SINGLE_ITERATION}
            placeholder={ITERATIONS_PLACEHOLDER}
            value={iterationCount === ITERATIONS_AUTO ? EMPTY : String(iterationCount)}
            onChange={(event) => {
              const next = Number.parseInt(event.currentTarget.value, 10);
              onIterationCount(Number.isNaN(next) ? ITERATIONS_AUTO : next);
            }}
          />
        </span>
      </label>

      <label className="flex items-center gap-1.5 text-2xs text-ink-dim">
        Delay
        <span className="w-16">
          <Field
            type="number"
            min={NO_DELAY_MS}
            value={String(delayRequestMs)}
            onChange={(event) => {
              const next = Number.parseInt(event.currentTarget.value, 10);
              onDelay(Number.isNaN(next) ? NO_DELAY_MS : next);
            }}
          />
        </span>
        ms
      </label>

      <label className="flex items-center gap-1.5 text-2xs text-ink-dim">
        <input
          type="checkbox"
          checked={bail}
          className="size-3 accent-accent"
          onChange={(event) => {
            onBail(event.currentTarget.checked);
          }}
        />
        Stop on failure
      </label>

      {iterationData === null ? (
        <Button
          variant="quiet"
          onClick={() => {
            void pickDataFile().then((picked) => {
              if (picked !== null) onIterationData(picked);
            });
          }}
        >
          Data file…
        </Button>
      ) : (
        <span className="flex items-center gap-1 text-2xs text-ink-dim">
          {/* The tail, not the path: the pane is 400px wide and the directory is not the answer. */}
          <span className="max-w-48 truncate font-mono" title={iterationData}>
            {fileTail(iterationData)}
          </span>
          <span className="text-ink-faint">{DATA_HINT}</span>
          <IconButton
            label="Clear data file"
            onClick={() => {
              onIterationData(null);
            }}
          >
            <CloseIcon />
          </IconButton>
        </span>
      )}

      <div className="flex-1" />
      {running ? (
        <Button variant="danger" onClick={onCancel}>
          <CancelIcon />
          Cancel
        </Button>
      ) : (
        <Button variant="primary" disabled={!runnable} onClick={onRun}>
          <SendIcon />
          Run
        </Button>
      )}
    </div>
  );
}

const PATH_SEPARATORS = /[/\\]/;

/** The last segment of a path, whichever separator the platform used. */
function fileTail(path: string): string {
  const parts = path.split(PATH_SEPARATORS);
  return parts[parts.length - SINGLE_ITERATION] ?? path;
}

/**
 * Progress, then the worst outcome, then the warnings.
 *
 * Everything here is read off the run, nothing is folded over the items. The exit code is the one
 * core decided and the CLI prints; the assertion counts are accumulated by the store as the events
 * arrive. A selector that folded here would allocate a fresh object on every call, and a store
 * snapshot that is never reference-equal to itself spins React until it throws.
 */
function Summary({ run }: { readonly run: Run }) {
  const totals = run.tests;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-line px-gutter py-1.5 text-2xs">
      <span className="text-ink-dim">
        <span className="text-ink">{String(run.items.length)}</span> of {String(run.total)}
      </span>
      {run.iterations > SINGLE_ITERATION && <span className="text-ink-dim">{String(run.iterations)} iterations</span>}
      {totals.passed > NOTHING && <span className="text-ok">{String(totals.passed)} passed</span>}
      {totals.failed > NOTHING && <span className="text-danger">{String(totals.failed)} failed</span>}
      {run.cancelled && <span className="text-warn">cancelled</span>}
      {run.exitCode !== null && <span className={toneClass(exitTone(run.exitCode))}>{exitLabel(run.exitCode)}</span>}
      {run.error !== null && <span className="text-danger">{run.error.message}</span>}
      {run.warnings.map((warning) => (
        <span key={warning} className="text-warn">
          {warning}
        </span>
      ))}
    </div>
  );
}

/** The list and the response, side by side. Persisted by the library, like every other split. */
function Exchange({ run }: { readonly run: Run }) {
  const layout = useDefaultLayout({ id: RUNNER_LAYOUT_ID, panelIds: [LIST_ID, DETAIL_ID], storage: localStorage });
  const focused = useFocusedRequest();

  return (
    <Group
      orientation="horizontal"
      className="min-h-0 flex-1"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      <Panel id={LIST_ID} defaultSize={LIST_DEFAULT} minSize={LIST_MIN} className="flex min-w-0 flex-col">
        <ItemList run={run} />
      </Panel>
      <Separator className="group relative z-handle w-px shrink-0 cursor-col-resize bg-line data-[state=drag]:bg-accent">
        <span className="absolute -inset-x-1 inset-y-0 group-hover:bg-accent/40" />
      </Separator>
      <Panel id={DETAIL_ID} minSize={DETAIL_MIN} className="flex min-w-0 flex-col">
        <ResponseView run={focused} />
      </Panel>
    </Group>
  );
}

function ItemList({ run }: { readonly run: Run }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: run.items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) => run.items[index] ?? index,
  });

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => (
          <ItemRow
            key={item.key}
            runId={run.runId}
            itemKey={run.items[item.index] ?? EMPTY}
            iterated={run.iterations > SINGLE_ITERATION}
            top={item.start}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One request in the run. Subscribed by key rather than reading the map, for the same reason the
 * sidebar has `useNode`: a five-thousand-row run must repaint the row that changed.
 */
function ItemRow({
  runId,
  itemKey,
  iterated,
  top,
}: {
  readonly runId: string;
  readonly itemKey: string;
  readonly iterated: boolean;
  readonly top: number;
}) {
  const item = useRequestItem(itemKey);
  const focused = useIsFocusedItem(itemKey);
  if (item === undefined) return null;

  const status = item.head?.status;
  const ms = durationOf(item.head);
  const tests = testTotals(item.tests);

  return (
    <button
      type="button"
      onClick={() => {
        useRunsStore.getState().focus(runId, itemKey);
      }}
      className={cn(
        "absolute inset-x-0 flex h-row items-center gap-2 px-gutter text-left",
        focused ? "bg-selected" : "hover:bg-hover",
      )}
      style={{ top }}
    >
      {iterated && (
        <span className="w-8 shrink-0 font-mono text-2xs text-ink-faint">
          #{String(item.iteration + SINGLE_ITERATION)}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-xs text-ink">{item.name}</span>
      {tests.failed > NOTHING && <span className="shrink-0 text-2xs text-danger">{String(tests.failed)}</span>}
      {status === undefined ? (
        <span className="shrink-0 text-2xs text-ink-faint">{item.status === "running" ? "…" : EMPTY}</span>
      ) : (
        <span className={cn("shrink-0 font-mono text-2xs", toneClass(statusTone(status)))}>{statusText(status)}</span>
      )}
      {ms !== null && <span className="w-12 shrink-0 text-right text-2xs text-ink-faint">{formatDuration(ms)}</span>}
    </button>
  );
}
