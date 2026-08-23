/**
 * What `contextBridge` puts on `window.preman`, and the channel names behind it.
 *
 * Imported by the main process, the preload script and the renderer, so it holds
 * declarations only: no `electron`, no `node:*`, nothing the renderer may not have.
 */

export const CHANNELS = {
  /** Main to renderer, carrying one end of a `MessageChannelMain`. */
  enginePort: "preman:engine-port",
  /** Main to renderer, when a host died more times than it is worth respawning. */
  hostFailure: "preman:host-failure",
  listWorkspaces: "preman:list-workspaces",
  pickWorkspace: "preman:pick-workspace",
  openWorkspace: "preman:open-workspace",
  forgetWorkspace: "preman:forget-workspace",
  revealInFileManager: "preman:reveal",
  pickDataFile: "preman:pick-data-file",
  saveReport: "preman:save-report",
  windowControl: "preman:window-control",
  readSession: "preman:read-session",
  saveSession: "preman:save-session",
} as const;

export type WindowControl = "minimise" | "maximise" | "close";

/**
 * The frameless window's geometry, shared because the main process positions the window's own
 * controls and the renderer has to lay a title bar out around them.
 *
 * macOS is the only platform this app goes frameless on. `hiddenInset` drops the native bar and
 * leaves the traffic lights, which is the whole trade: the app gets the row back and the user
 * keeps the three buttons every other Mac window has. Elsewhere the window keeps its native
 * frame, because a hand-drawn close button that cannot be tested is worse than a title bar.
 */
/** Must equal `--spacing-bar`, the same way `ROW_HEIGHT` must equal `--spacing-row`. */
export const TITLE_BAR_HEIGHT_PX = 40;
export const TRAFFIC_LIGHT_INSET_PX = 12;
/** Three 12px buttons, two 8px gaps, plus the inset again as breathing room before the first control. */
export const TITLE_BAR_GUTTER_PX = 76;
/** The cluster is 12px tall; centring it is arithmetic, not a guess. */
export const TRAFFIC_LIGHT_HEIGHT_PX = 12;

export interface WorkspaceHandle {
  root: string;
  /** The basename, which is what the workspace switcher shows. */
  name: string;
  lastOpenedAt: number;
}

/**
 * A tab the user had open. `subTab` is `string | null` rather than the renderer's `SubTab` union
 * because this file is also compiled into the main process, which has no business knowing which
 * sub-tabs an editor has; the renderer validates the value on the way back in.
 */
export interface SessionTab {
  nodeId: string;
  subTab: string | null;
}

/**
 * An unsaved edit. Persisted so a crash costs nothing, and persisted to app data rather than into
 * the workspace so an unsaved edit is recoverable without being committable.
 */
export interface SessionDraft {
  nodeId: string;
  /** A serialised `FieldEdit[]`. The renderer owns the shape; nothing outside it looks inside. */
  edits: unknown;
  text: string | null;
}

/**
 * Everything the app remembers about one workspace between runs.
 *
 * This is both the wire shape and the stored shape, on purpose: a mapping layer between the two
 * would be one more place for the two to drift apart while both compile.
 */
export interface SessionSnapshot {
  /**
   * Which environment was chosen: a name, `null` for an explicit "none", and absent for a choice
   * nobody has made yet. Optional rather than a third string value because that is exactly what
   * JSON does with `undefined` - the key is simply not written - so the file needs no sentinel.
   */
  activeEnvironment?: string | null;
  activeNodeId: string | null;
  collapsedIds: string[];
  tabs: SessionTab[];
  drafts: SessionDraft[];
}

/**
 * A `MessagePort` cannot cross `contextBridge` — Electron's object serialisation does
 * not carry one — so the preload relays it into the main world with `window.postMessage`,
 * which does. This is the tag the renderer matches on.
 */
export const ENGINE_PORT_WINDOW_MESSAGE = "preman:engine-port-transfer";

export interface EnginePortDelivery {
  kind: typeof ENGINE_PORT_WINDOW_MESSAGE;
  root: string;
}

/**
 * The renderer's half of a `MessageChannelMain`, narrowed to what a client needs.
 *
 * Declared structurally rather than as `MessagePort` because this module is compiled
 * into both a Node program and a DOM one, and it doubles as the statement of exactly
 * how much of the port the renderer is given.
 */
export interface EnginePort {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  start(): void;
  close(): void;
}

/** A host that will not come back. Carries `details[]` for the same reason `EngineError` does. */
export interface HostFailure {
  root: string;
  message: string;
  details: string[];
}

export interface PremanBridge {
  /**
   * Pixels the title bar must leave clear at its leading edge for the window's own controls.
   * Zero when the window has a native frame, so the renderer never asks which platform it is on.
   */
  readonly titleBarGutter: number;
  /** Returns an unsubscribe function, so a re-render cannot stack listeners. */
  onHostFailure(listener: (failure: HostFailure) => void): () => void;
  listWorkspaces(): Promise<WorkspaceHandle[]>;
  /** A native directory dialog. `null` when the user cancelled. */
  pickWorkspaceDirectory(): Promise<string | null>;
  /** Ask for a host for `root`. The port arrives through `onEnginePort`. */
  openWorkspace(root: string): Promise<void>;
  forgetWorkspace(root: string): Promise<void>;
  revealInFileManager(target: string): Promise<void>;
  /**
   * A native file dialog for a runner's iteration data. `null` when the user cancelled.
   * The engine resolves whatever comes back, so the dialog does not have to stay inside
   * the workspace: iteration data is commonly kept beside a test suite, not inside it.
   */
  pickDataFile(): Promise<string | null>;
  /**
   * A native save dialog for an already-rendered report. The renderer never names a file
   * system location, and the main process does the writing. Resolves to the path written,
   * or `null` when the user cancelled.
   */
  saveReport(suggestedName: string, text: string): Promise<string | null>;
  controlWindow(action: WindowControl): void;
  /** What was open in `root` last time. An unknown root reads as an empty session, not an error. */
  readSession(root: string): Promise<SessionSnapshot>;
  saveSession(root: string, snapshot: SessionSnapshot): Promise<void>;
}
