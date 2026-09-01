/**
 * The typed contract between an engine host and whatever drives it.
 *
 * This is the only module both the engine and the renderer import, so it must stay
 * free of runtime dependencies on `@preman/core`: every core import here is a type
 * import, erased at build time. That is what lets the renderer name a `Catalog`
 * without being able to call `runRequest`.
 */
import type { BodyHead, BodyMatch, BodyWindow } from "@preman/core/api/bodies.js";
import type { Catalog, CatalogNode, CatalogNodeKind, CatalogProtocol } from "@preman/core/api/catalog.js";
import type { FailureStage, RunEvent } from "@preman/core/api/events.js";
import type { SnapshotEnvironment } from "@preman/core/api/inspect.js";
import type { GitFileStatus, GitStatus } from "@preman/core/api/git.js";
import type { GrepMatch, GrepResult } from "@preman/core/api/grep.js";
import type { FieldEdit, RequestKind } from "@preman/core/api/mutate.js";
import type { TextPreview } from "@preman/core/api/preview.js";
import type {
  DeclaredSpec,
  LinkAction,
  LinkOverride,
  PlannedLink,
  PlannedSpec,
  SpecPlan,
  SpecsView,
} from "@preman/core/api/specs.js";
import type { VariableBinding, VariableLayer, VariableView } from "@preman/core/api/variables.js";
import type { ExitCode } from "@preman/core/errors.js";
import type { SharedLink } from "@preman/core/workspace/links.js";
import type { Scope } from "@preman/core/vars/store.js";

export type {
  BodyHead,
  BodyMatch,
  BodyWindow,
  Catalog,
  CatalogNode,
  CatalogNodeKind,
  CatalogProtocol,
  DeclaredSpec,
  ExitCode,
  FailureStage,
  FieldEdit,
  GitFileStatus,
  GitStatus,
  GrepMatch,
  GrepResult,
  LinkAction,
  LinkOverride,
  PlannedLink,
  PlannedSpec,
  RequestKind,
  RunEvent,
  Scope,
  SharedLink,
  SnapshotEnvironment,
  SpecPlan,
  SpecsView,
  TextPreview,
  VariableBinding,
  VariableLayer,
  VariableView,
};

/** Environments are files in the workspace but not rows in the tree, so they need their own kind. */
export type DocumentKind = CatalogNodeKind | "environment";

/**
 * A `PremanError` flattened for the wire. `details` is carried, never dropped: a GUI
 * that swallows the actionable half of an engine error is worse than the CLI.
 */
export interface EngineError {
  message: string;
  details: string[];
  exitCode: ExitCode;
}

export interface NodeDocument {
  nodeId: string;
  /** Where the bytes actually live. A group node reads its `.resources/definition.yaml`. */
  file: string;
  kind: DocumentKind;
  /** The file exactly as it sits on disk, for the raw YAML tab. */
  text: string;
  /** The parsed document, structured-cloneable, for the field editors. */
  data: unknown;
}

export type MutateOp =
  | { op: "create-request"; parentId: string; name: string; kind: RequestKind; order?: number }
  | { op: "create-folder"; parentId: string; name: string; order?: number }
  | { op: "create-collection"; name: string; order?: number }
  | { op: "create-environment"; name: string }
  /** Requests only, and `order` omitted lands the copy last. See `duplicateRequestFile`. */
  | { op: "duplicate"; targetId: string; order?: number }
  | { op: "rename"; targetId: string; name: string }
  | { op: "move"; targetId: string; parentId: string; order?: number }
  | { op: "delete"; targetId: string }
  | { op: "reorder"; orderById: Record<string, number> };

export type MutateOpName = MutateOp["op"];

export interface MutateResult {
  /** The node that now exists, or `null` for an operation that produced no single node. */
  nodeId: string | null;
  revision: number;
}

export interface RunArgs {
  nodeId: string;
  /**
   * A name picks that environment; `null` runs with none. Absent is not the same as
   * `null`: it leaves the choice to the engine, which adopts a sole environment. Encoded
   * as `null` rather than a sentinel string so it survives the structured clone intact.
   */
  environment?: string | null;
  iterationCount?: number;
  /** A JSON or CSV path, resolved by the engine against the workspace. */
  iterationData?: string;
  bail?: boolean;
  delayRequestMs?: number;
  timeoutMs?: number;
}

/** A layer the environment manager can write to, and the value to put there. */
export interface VariableWrite {
  /** The environment's name. Only environment files are writable; globals are read-only. */
  environment: string;
  key: string;
  value: string;
}

/**
 * The formats a finished run can be exported as. Both are core's, because the desktop app
 * adds no report format of its own: whatever `preman -r` can write, this can write.
 */
export const REPORT_FORMATS = ["json", "junit"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface RunReportText {
  format: ReportFormat;
  /** The bytes a reporter would have written, for the renderer to hand to a save dialog. */
  text: string;
  /** A file name to offer, derived from what ran. */
  suggestedName: string;
}

/**
 * A run is acknowledged before it starts and reported through pushes, so a caller
 * can correlate events with a run it has not finished issuing. The outcome is not
 * here: the events are the result, and `run-done` is the terminal signal.
 */
export interface RunAcknowledgement {
  runId: string;
}

/**
 * One method a picker can offer, with everything needed to write it into a request.
 *
 * `schemaLocation` is the reason this is not simply core's `ProtoMethod`. Choosing a
 * method means writing `methodPath` *and* `schema.location`, and that location is
 * relative to the request file that will carry it — arithmetic the renderer cannot do,
 * because it may not import `node:path` and hand-rolling a `relative()` over a
 * separator it is not allowed to know is how a picker starts writing broken paths.
 */
export interface MethodChoice {
  /** `pkg.Service.Method`, exactly as `methodPath` is written. */
  methodPath: string;
  serviceName: string;
  methodName: string;
  /** Absolute path of the declaring spec, for revealing it in a file manager. */
  spec: string;
  /** The same spec as a workspace-relative posix path, for showing which proto it was. */
  specLabel: string;
  requestType: string;
  responseType: string;
  /** Offered, and refused on send. A method missing from a picker reads as a broken index. */
  streaming: boolean;
  /** What to write into `schema.location`. Present only when a `nodeId` was supplied. */
  schemaLocation?: string;
}

export interface MethodChoices {
  methods: readonly MethodChoice[];
  /** A spec that would not load. Carried so a missing method has a stated reason. */
  warnings: readonly string[];
}

export type EngineRequest =
  | { id: number; kind: "catalog" }
  | { id: number; kind: "read-node"; nodeId: string }
  | { id: number; kind: "write-node"; nodeId: string; edits: FieldEdit[] }
  | { id: number; kind: "write-text"; nodeId: string; text: string }
  | { id: number; kind: "mutate"; op: MutateOp }
  | { id: number; kind: "run"; args: RunArgs }
  | { id: number; kind: "cancel"; runId: string }
  | { id: number; kind: "variables"; environment: string | null }
  | { id: number; kind: "write-variable"; write: VariableWrite }
  /**
   * What a text would become on the next run. Not a field on `variables`: one is a property
   * of the workspace, the other is a function of a string that changes on every keystroke.
   */
  | { id: number; kind: "preview"; text: string; environment: string | null }
  | { id: number; kind: "run-report"; runId: string; format: ReportFormat }
  /**
   * Every method the workspace's declared protos offer. With a `nodeId` each choice also
   * carries the `schema.location` that request would need, so picking one is two field
   * edits and no path arithmetic on this side of the port.
   */
  | { id: number; kind: "list-methods"; nodeId?: string }
  /**
   * A request body for a method, with `{{token}}` where a string field's name is a
   * variable that exists. The environment is named because the tokens depend on it, and
   * `null` means "none" exactly as it does on a run.
   */
  | { id: number; kind: "message-skeleton"; methodPath: string; environment: string | null }
  | { id: number; kind: "grep"; query: string; limit?: number }
  | { id: number; kind: "git-status" }
  /** Which protos this workspace declares, and which shared links they need to resolve. */
  | { id: number; kind: "specs" }
  /** Every `.proto` under a directory, so picking a folder is one round trip and not a walk. */
  | { id: number; kind: "collect-protos"; dir: string }
  /**
   * What declaring these files would write, without writing it: the links it would create,
   * the path each spec would get, and whether each one actually loads. Staged rather than
   * applied because creating a link is a side effect on a directory other workspaces share.
   */
  | { id: number; kind: "plan-specs"; files: string[]; overrides?: Record<string, LinkOverride> }
  /** The same, for specs already declared off a link. What the reviewable "convert all" reads. */
  | { id: number; kind: "plan-conversion"; overrides?: Record<string, LinkOverride> }
  | { id: number; kind: "apply-specs"; plan: SpecPlan }
  /** Unlinks the spec from `resources.yaml`. Never deletes the link: another workspace may hold it. */
  | { id: number; kind: "remove-spec"; declared: string }
  /**
   * Points a shared link at a checkout on this machine. The repair half of the design: the
   * spec paths are already correct, they just need somewhere local to land.
   */
  | { id: number; kind: "link-checkout"; name: string; target: string; repoint?: boolean }
  | { id: number; kind: "body-head"; handle: string }
  | { id: number; kind: "body-window"; handle: string; offset: number; length?: number }
  | { id: number; kind: "body-search"; handle: string; query: string; limit?: number }
  | { id: number; kind: "body-format"; handle: string }
  | { id: number; kind: "body-release"; handle: string }
  /**
   * What this engine host marked, and when. A `utilityProcess` has no CDP endpoint, so there is
   * no other way to read its phases: the one phase that dominates a workspace open is the one
   * phase an external profiler is structurally blind to.
   */
  | { id: number; kind: "phases" };

export type EngineRequestKind = EngineRequest["kind"];

export type EngineRequestFor<K extends EngineRequestKind> = Extract<EngineRequest, { kind: K }>;

/** Everything a caller supplies for a request kind. The envelope is the host's business. */
export type EnginePayload<K extends EngineRequestKind> = Omit<EngineRequestFor<K>, "id" | "kind">;

/** What each request kind resolves to. A typed client is derived from this, not duplicated. */
export interface EngineResults {
  catalog: Catalog;
  "read-node": NodeDocument;
  "write-node": NodeDocument;
  "write-text": NodeDocument;
  mutate: MutateResult;
  run: RunAcknowledgement;
  cancel: null;
  variables: VariableView;
  /** The re-read view, so one edit costs one round trip and cannot show a stale winner. */
  "write-variable": VariableView;
  preview: TextPreview;
  "run-report": RunReportText;
  "list-methods": MethodChoices;
  /** The body text itself, ready to drop into `message.content`. */
  "message-skeleton": string;
  grep: GrepResult;
  "git-status": GitStatus;
  specs: SpecsView;
  "collect-protos": string[];
  "plan-specs": SpecPlan;
  "plan-conversion": SpecPlan;
  /** The re-read view, so applying a plan cannot leave the pane showing what it replaced. */
  "apply-specs": SpecsView;
  "remove-spec": SpecsView;
  "link-checkout": SpecsView;
  "body-head": BodyHead;
  "body-window": BodyWindow;
  "body-search": BodyMatch[];
  "body-format": string;
  "body-release": null;
  phases: PhaseReport;
}

export type EngineResult = EngineResults[EngineRequestKind];

export type EngineResponse =
  { id: number; ok: true; data: EngineResult } | { id: number; ok: false; error: EngineError };

export type EnginePush =
  | { push: "run-event"; event: RunEvent }
  /**
   * The terminal signal for a run, and the only one that always arrives. A selector
   * that resolves to nothing fails before core emits anything, so `run-end` cannot
   * be relied on; `error` carries the `details[]` that failure produced.
   */
  | { push: "run-done"; runId: string; warnings: string[]; cancelled: boolean; error?: EngineError }
  | { push: "catalog"; catalog: Catalog }
  | { push: "external-change"; nodeIds: string[] }
  /**
   * The tree's decorations, re-read after the workspace changed. Pushed rather than
   * polled: a branch switch changes every row at once, and the watcher already knows.
   */
  | { push: "git-status"; status: GitStatus }
  /** The watcher could not do its job. Never silent: external edits will be missed. */
  | { push: "degraded"; message: string };

export type EngineMessage = EngineResponse | EnginePush;

export function isEnginePush(message: EngineMessage): message is EnginePush {
  return "push" in message;
}

/**
 * The handshake that hands an engine host one end of a `MessageChannelMain`. Named
 * here because the main process sends it and the engine receives it, and a string
 * literal duplicated across a process boundary is a bug waiting to happen.
 */
export const ENGINE_PORT_MESSAGE = "engine-port";

/** What `--workspace-root=` prefixes on the engine host's argv. */
export const WORKSPACE_ROOT_FLAG = "--workspace-root=";

/**
 * How severe a line in `preman.log` is.
 *
 * Four, and deliberately no `debug`: a debug level is a level somebody has to turn on, and 035
 * refused the switch. These are labels on a file that is always written at one detail, not a
 * filter. `info` is something happening, `warn` is something the user will want to know went
 * wrong while the app carried on, `error` is an operation that failed, `fatal` is a process
 * that is not coming back.
 */
export const LOG_LEVELS = ["info", "warn", "error", "fatal"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

const LOG_TAG_OPEN = "<preman:";
const LOG_TAG_CLOSE = ">";
/** What an untagged line is worth. Third-party output — Node's own `Debugger listening on
 * ws://…`, a dependency's stray write — arrives with no opinion, and guessing one from the text
 * is the pattern-matching this codebase does not do. */
const UNTAGGED_LEVEL: LogLevel = "info";

const LEVEL_BY_NAME: ReadonlyMap<string, LogLevel> = new Map(LOG_LEVELS.map((level) => [level, level]));

/**
 * One line of engine output, marked with what the engine meant by it.
 *
 * The engine host writes to a pipe only the main process reads, and main is the only writer of
 * the log (035). Without a mark, main would have to decide the severity of a line it did not
 * write, so an engine stack trace and a debugger banner would land at the same level. The tag is
 * printable rather than a control character: if it ever reaches a human — an engine run outside
 * Electron, a pipe read by something else — it should read as a word and not as mojibake.
 */
export function tagLine(level: LogLevel, line: string): string {
  return `${LOG_TAG_OPEN}${level}${LOG_TAG_CLOSE}${line}`;
}

export interface TaggedLine {
  readonly level: LogLevel;
  readonly message: string;
}

/**
 * Split a captured line back into what the engine meant and what it said.
 *
 * Anything that is not exactly a known level between the delimiters is left alone, tag and all:
 * a line that merely starts with `<preman:` is somebody else's text, and eating it would lose
 * output to a near miss.
 */
export function readTaggedLine(line: string): TaggedLine {
  if (!line.startsWith(LOG_TAG_OPEN)) return { level: UNTAGGED_LEVEL, message: line };
  const close = line.indexOf(LOG_TAG_CLOSE, LOG_TAG_OPEN.length);
  if (close < 0) return { level: UNTAGGED_LEVEL, message: line };
  const level = LEVEL_BY_NAME.get(line.slice(LOG_TAG_OPEN.length, close));
  if (level === undefined) return { level: UNTAGGED_LEVEL, message: line };
  return { level, message: line.slice(close + LOG_TAG_CLOSE.length) };
}

/**
 * The boundaries a workspace open crosses, grouped by the process that marks them.
 *
 * Grouped, not ordered: the engine's catalog build is triggered by the renderer asking for it, so
 * `engineCatalogEnter` lands after `rendererCatalogAsked` on the wall clock even though it is
 * listed above it. The causal order is asserted in `test/renderer/perf.app.test.ts`, which is the
 * only place that has all three reports in hand.
 *
 * These names live here, beside `ENGINE_PORT_MESSAGE`, for that constant's own reason: three
 * processes mark them and one reader joins them, so a name spelled twice across a process
 * boundary would produce a timeline that silently loses a phase. Decision 027.
 *
 * They ship. A mark costs sub-microseconds once per workspace open, and the alternative — a build
 * flag — would put the measured build one flag away from the shipped one and make the field
 * unprofilable. The marks carry timings and nothing else: no paths, no node ids, no bodies.
 */
export const PHASES = {
  mainStart: "preman.main.start",
  mainPrewarm: "preman.main.prewarm",
  mainWindowShown: "preman.main.window-shown",
  mainPortPosted: "preman.main.port-posted",
  engineStart: "preman.engine.start",
  engineCatalogEnter: "preman.engine.catalog.enter",
  engineCatalogExit: "preman.engine.catalog.exit",
  rendererPortReceived: "preman.renderer.port-received",
  /**
   * The one phase that does not always fire, and the only one whose absence is the good outcome:
   * a workspace that opened fast enough never showed a placeholder. So a timeline without it is a
   * timeline of an open nobody had to wait through.
   */
  rendererSkeletonShown: "preman.renderer.skeleton-shown",
  rendererCatalogAsked: "preman.renderer.catalog.asked",
  rendererCatalogArrived: "preman.renderer.catalog.arrived",
  rendererReplaceEnter: "preman.renderer.replace.enter",
  rendererReplaceExit: "preman.renderer.replace.exit",
  rendererRowsPainted: "preman.renderer.rows-painted",
} as const;

export type Phase = (typeof PHASES)[keyof typeof PHASES];

export interface PhaseMark {
  name: string;
  /** Milliseconds since this process's own `timeOrigin`. */
  at: number;
}

export interface PhaseReport {
  /** Unix-epoch milliseconds. Added to `at` this puts every process on one timeline. */
  timeOrigin: number;
  marks: readonly PhaseMark[];
}

/**
 * What every phase name starts with, and so what {@link readPhases} keeps.
 *
 * Exported because a profiler reading the main process cannot call `readPhases` — a function
 * handed to `ElectronApplication.evaluate` is serialized and re-parsed, so it arrives without its
 * imports — and the prefix is the one fact it has to be told rather than guess.
 */
export const PHASE_PREFIX = "preman.";
const MARK_ENTRY_TYPE = "mark";

/**
 * Record a phase on this process's own timeline.
 *
 * Guards nothing and swallows nothing: the argument is a union of fourteen literals, so a mark
 * that could throw is a mark whose name does not exist, which is a compile error and not a
 * runtime one.
 */
export function markPhase(phase: Phase): void {
  performance.mark(phase);
}

/**
 * Every phase this process marked, with the origin needed to compare it to another process's.
 *
 * `performance` is a global in Chromium and in Node, which is why this can live on the wire
 * contract without giving it a dependency. The prefix filter is what keeps a caller's own marks —
 * or a library's — out of the report.
 */
export function readPhases(): PhaseReport {
  const marks = performance
    .getEntriesByType(MARK_ENTRY_TYPE)
    .filter((entry) => entry.name.startsWith(PHASE_PREFIX))
    .map((entry) => ({ name: entry.name, at: entry.startTime }));
  return { timeOrigin: performance.timeOrigin, marks };
}

/**
 * The wire's own copy of core's `EXIT`.
 *
 * Declared rather than re-exported so that importing this module never pulls a line of
 * `@preman/core` into the renderer bundle: everything else here is a type, and types
 * erase. `test/desktop.protocol.test.ts` pins these values to core's, so the duplication
 * cannot drift without a red test.
 */
export const EXIT_CODES = {
  OK: 0,
  CLI: 1,
  TRANSPORT: 2,
  BUSINESS: 3,
  TEST: 4,
} as const satisfies Record<string, ExitCode>;

/**
 * The wire's own copy of core's token pattern, as a source string rather than a `RegExp`: a global
 * regex carries `lastIndex`, so a shared instance is a bug two callers apart. Pinned to core's
 * `TOKEN_SOURCE` by `test/desktop.protocol.test.ts`.
 *
 * Deliberately not `ui/template.ts`'s `MASK_PATTERN`, which is wider — it masks `{{}}` too, and it
 * has no capture group, because the masker needs a length and not a name.
 */
export const VARIABLE_TOKEN_SOURCE = String.raw`\{\{\s*([^{}]+?)\s*\}\}`;

/**
 * The gap left between siblings, and the stand-in for a sibling that declares no
 * `order`. Both are core's (`workspace/paths.ts` and `api/catalog.ts`), duplicated
 * here for the same reason as `EXIT_CODES`: whoever plans a reorder needs the numbers,
 * and a renderer that imported them from core would be importing the engine.
 *
 * `test/desktop.protocol.test.ts` pins both to core, so the duplication cannot drift.
 */
export const ORDER_STEP = 1000;
export const ORDER_ABSENT = Number.MAX_SAFE_INTEGER;

/**
 * How large one `body-window` is, and the size above which the engine refuses to
 * pretty-print. Both are the renderer's arithmetic: one paces the windowed viewer, the
 * other decides whether the pretty-print toggle is offered at all. Asking and being
 * refused is a worse experience than a disabled control that says why.
 *
 * `BODY_WINDOW_BYTES` lives here rather than in the host because both ends use it - the
 * host as the default `length`, the renderer as the stride it walks. `test/desktop.protocol.test.ts`
 * pins `BODY_FORMAT_LIMIT_BYTES` to core's, so that one cannot drift.
 */
export const BODY_WINDOW_BYTES = 64 * 1024;
export const BODY_FORMAT_LIMIT_BYTES = 2 * 1024 * 1024;

/**
 * What a group's node id has to gain to become the path of the file it edits.
 *
 * A node id is a workspace-relative posix path, and `git status` reports the same kind of
 * path, so matching one to the other is string work rather than a lookup - except for a
 * group, whose id is its *directory*. This is core's `RESOURCES_DIR` and `DEFINITION_FILE`
 * joined, duplicated here because the renderer decorates the tree and may not import
 * `node:path`. `test/desktop.protocol.test.ts` pins it to core.
 */
export const GROUP_DEFINITION_SUFFIX = "/.resources/definition.yaml";

/**
 * Where a declared spec path says its checkout lives.
 *
 * Core's (`workspace/links.ts`), duplicated here because the settings pane shows it as the
 * placeholder under an empty override field - the value a reader needs in order to decide
 * whether to type anything at all. `test/desktop.protocol.test.ts` pins it to core.
 *
 * Worth being precise about what an override does and does not change: this string is what
 * gets *written* into `resources.yaml` on every machine, and the override only says where
 * *this* machine resolves it. That asymmetry is the whole reason a shared root is portable
 * at all, so a pane that offers the override has to show the constant beside it.
 */
export const SHARED_PROTO_ROOT = "/Users/Shared/postman-protos";

/**
 * The variable a host reads that root from.
 *
 * Also core's, and duplicated for a reason worth stating precisely because the obvious one turns
 * out to be wrong. Main sets this on `process.env` before it forks anything, and it first read
 * the name straight from `@preman/core/workspace/links.js`. That was measured, on the suspicion
 * that 033's bundle trap had been walked into again: `dist/main/main.js` is 51.68 kB with the
 * core import and 52.04 kB without it, so rolldown was shaking it out and there were no bytes to
 * save. What is left is the graph rather than its weight - main reaches into core for exactly one
 * thing, an error class, and a second reach for a string is the kind of edge that is easy to add
 * and hard to notice. Pinned to core in the same test.
 */
export const SHARED_PROTO_ROOT_ENV = "PREMAN_SHARED_PROTO_ROOT";
