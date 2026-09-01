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
  createWorkspace: "preman:create-workspace",
  /** Main to renderer, from the File menu's Create New Workspace item. */
  openCreateWorkspace: "preman:open-create-workspace",
  /** Main to renderer, from the File menu's Migrate from Postman item. */
  openMigrate: "preman:open-migrate",
  listPostmanWorkspaces: "preman:list-postman-workspaces",
  migratePostmanWorkspace: "preman:migrate-postman-workspace",
  /**
   * Main to renderer, while a migration runs. A push rather than a reply, because the migration
   * itself is one `invoke` that does not settle for the better part of a minute.
   */
  migrateProgress: "preman:migrate-progress",
  forgetWorkspace: "preman:forget-workspace",
  revealInFileManager: "preman:reveal",
  pickDataFile: "preman:pick-data-file",
  /** A native dialog for one or more `.proto` files to declare. */
  pickProtoFiles: "preman:pick-proto-files",
  /** A native dialog for a directory to sweep for `.proto` files. */
  pickProtoFolder: "preman:pick-proto-folder",
  /** A native dialog for the checkout a named shared link should point at. */
  pickCheckout: "preman:pick-checkout",
  saveReport: "preman:save-report",
  windowControl: "preman:window-control",
  readSession: "preman:read-session",
  saveSession: "preman:save-session",
  /**
   * Synchronous, and the only channel that is. The renderer needs the theme before its first
   * paint, and a promise cannot be awaited before `createRoot().render()` without showing a frame
   * of something. See `docs/decisions/022`.
   */
  readPreferences: "preman:read-preferences",
  /**
   * Which workspace the main process decided to reopen at launch, so the first thing the window
   * says about it is not "No workspace open."
   *
   * Asynchronous, unlike `readPreferences` above, and deliberately so. The theme has to be right
   * in the first painted frame because a light flash on a dark app is unmissable; this one only
   * has to be right before the delay behind the skeleton expires, which is 150ms of headroom for
   * an IPC round trip that takes well under one. Decision 022 argues for exactly one synchronous
   * channel, and this is not the second.
   */
  readReopening: "preman:read-reopening",
  savePreferences: "preman:save-preferences",
  /** Renderer to main, after a theme or density change moved the window's own chrome. */
  setWindowChrome: "preman:set-window-chrome",
  /** Main to renderer, from the app menu's Settings item. */
  openSettings: "preman:open-settings",
  /**
   * Where the log is and what versions are running, for the Settings pane's Diagnostics section.
   *
   * Asynchronous, like every channel but `readPreferences`. Decision 022 argues for exactly one
   * synchronous channel, and a section the user has to open a pane to see is not it.
   */
  readDiagnostics: "preman:read-diagnostics",
  /**
   * Main to renderer, once a second while the Settings pane's Resources tab is open.
   *
   * A push rather than a reply, for the same reason `migrateProgress` is one: a single reading is
   * not the answer. `percentCPUUsage` is an average over the interval since that process was last
   * sampled, so a sample only means anything as the next one in a series.
   */
  resourceSample: "preman:resource-sample",
  /**
   * Renderer to main, when the Resources tab mounts and again when it unmounts.
   *
   * Fire-and-forget, like `setWindowChrome`: the acknowledgement is the next push. This is the
   * whole gate — outside these two messages main holds no sampling timer, so an app with the tab
   * shut costs exactly what it did before `docs/decisions/040`.
   */
  watchResources: "preman:watch-resources",
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
/** The `default` density's `--spacing-bar`. The stored preference overrides it; this is the floor. */
export const TITLE_BAR_HEIGHT_PX = 40;
export const TRAFFIC_LIGHT_INSET_PX = 12;
/**
 * Three 12px buttons, two 8px gaps, plus the inset again as breathing room before the first
 * control. Unlike the bar's height this does not move with density: the traffic lights are the
 * system's, drawn at the system's size, so the space they need is the system's too.
 */
export const TITLE_BAR_GUTTER_PX = 76;
/** The cluster is 12px tall; centring it is arithmetic, not a guess. */
export const TRAFFIC_LIGHT_HEIGHT_PX = 12;
/** `preman-dark`'s `--color-canvas`. What the window is painted before the renderer has loaded. */
export const DEFAULT_CANVAS = "#111214";

/**
 * How tightly the interface is packed. Three presets rather than a scale slider: every row height,
 * every control height and every type size has to stay in proportion, and a free multiplier makes
 * that a rounding problem at every step. See `docs/decisions/021`.
 */
export type Density = "compact" | "default" | "comfortable";

/**
 * What the user chose about how the app looks. Global, not per-workspace — a theme is a property
 * of the person, and two windows onto two workspaces that disagreed about their colours would be
 * two apps.
 *
 * `canvas` and `barHeightPx` are denormalised copies of two values the theme and the density
 * already determine. They are here so the main process can paint the window and place the traffic
 * lights without knowing what a theme is; that keeps `main/` ignorant of `renderer/appearance/`,
 * at the cost of one launch of staleness if the two ever drift. The renderer corrects them on
 * every save, so they cannot drift twice.
 */
export interface Preferences {
  themeId: string;
  density: Density;
  /** Pixels, and the editor's alone. The rest of the type scale moves with `density`. */
  editorFontSize: number;
  /** A family name to put in front of the default stack, or `null` for the stack as shipped. */
  fontMono: string | null;
  fontSans: string | null;
  canvas: string;
  barHeightPx: number;
  /**
   * Where this machine keeps its shared proto links, or `null` for the directory core defaults to.
   *
   * A preference rather than a workspace setting on purpose: the point of the shared root is that
   * a declared spec path means the same thing everywhere, so the path written into
   * `resources.yaml` is always the default one and this only says where *this* machine resolves
   * it. A locked-down machine that cannot write to the default needs somewhere else to put its
   * links; it does not need its colleagues' workspaces to know that.
   */
  sharedProtoRoot: string | null;
}

/** The editor's size in `app.css` today, so a fresh install renders exactly as it does now. */
export const DEFAULT_EDITOR_FONT_SIZE_PX = 12;

/**
 * What a fresh install looks like, and what a state file from another version falls back to.
 * `preman-dark` is the theme every contrast number in `docs/design-system.md` was measured
 * against, so the default is also the reference.
 */
export const DEFAULT_PREFERENCES: Preferences = {
  themeId: "preman-dark",
  density: "default",
  editorFontSize: DEFAULT_EDITOR_FONT_SIZE_PX,
  fontMono: null,
  fontSans: null,
  canvas: DEFAULT_CANVAS,
  barHeightPx: TITLE_BAR_HEIGHT_PX,
  sharedProtoRoot: null,
};

/** The two things about the window itself that a preference change moves. */
export interface WindowChrome {
  canvas: string;
  barHeightPx: number;
}

export interface WorkspaceHandle {
  root: string;
  /** The basename, which is what the workspace switcher shows. */
  name: string;
  lastOpenedAt: number;
}

/**
 * What creating a workspace answers.
 *
 * A refusal is a value, not a rejection. An unusable name and an existing directory are expected
 * answers that the naming dialog shows beside the field, and Electron reports anything thrown
 * inside `ipcMain.handle` as `Error invoking remote method …` — a sentence about IPC, not about
 * what the user typed. Only genuinely unexpected failures are left to reject.
 */
export type CreateWorkspaceResult =
  { readonly ok: true; readonly root: string } | { readonly ok: false; readonly message: string };

/**
 * One workspace in the signed-in Postman account.
 *
 * Declared here rather than imported from `@preman/core`: this file is also compiled into the
 * renderer, which may not reach the engine in process. The shape is core's `CloudWorkspace`
 * narrowed to what a list row draws, so main assigns the real thing to it without a mapping step.
 *
 * No per-workspace counts. Postman's `/workspaces` answers with identity only — collections live
 * behind one `/workspace/{id}?populate=true` each — and a list of forty workspaces is not worth
 * forty round trips to put a number beside each name.
 */
export interface CloudWorkspace {
  readonly id: string;
  readonly name: string;
  /** Postman's own word: `team`, `personal`, `private`. Absent when Postman did not say. */
  readonly type?: string;
}

/** What a migration wrote, narrowed from core's `MigrationOutcome` to what the pane reports. */
export interface MigrateOutcome {
  readonly root: string;
  readonly workspaceName: string;
  /** Keyed by kind: `collection`, `folder`, `environment`, `grpc-request`, `http-request`. */
  readonly counts: Readonly<Record<string, number>>;
  /** What Postman had and preman cannot represent. Named, never silently dropped. */
  readonly skipped: readonly { readonly path: string; readonly kind: string }[];
}

/**
 * How far a running migration has got, mirroring core's `MigrationProgress` for a renderer that
 * may not import it.
 *
 * `total` is `undefined` for a phase whose size cannot be known — which is most of them, because
 * the walk discovers the tree as it reads it. That is not a value to be filled in with a guess:
 * a reader draws indeterminate, and `postman/progress.ts` in core says why the collection is the
 * only honest unit.
 */
export interface MigrationProgress {
  readonly phase: string;
  readonly done: number;
  readonly total: number | undefined;
  /** Proxy reads finished so far. Rises without a ceiling; never drawn as a proportion. */
  readonly calls: number;
}

/**
 * A failure worth showing, carrying `details[]` for the same reason `HostFailure` does: a
 * migration fails for reasons the user can act on — Postman Desktop is not running, the
 * destination is not empty — and the advice is half the answer.
 *
 * A value, not a rejected invoke, on the same reasoning as `CreateWorkspaceResult`: Electron
 * reports anything thrown inside `ipcMain.handle` as `Error invoking remote method …`, which is a
 * sentence about IPC rather than about Postman.
 */
export interface MigrateFailure {
  readonly status: "failed";
  readonly message: string;
  readonly details: readonly string[];
}

/** `cancelled` is the native destination dialog being dismissed, which is not a failure. */
export type MigrateResult =
  { readonly status: "migrated"; readonly outcome: MigrateOutcome } | { readonly status: "cancelled" } | MigrateFailure;

export type CloudWorkspaceListResult =
  { readonly status: "listed"; readonly workspaces: readonly CloudWorkspace[] } | MigrateFailure;

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
  /**
   * Fires when the far end is gone: the host crashed, was killed, or was reaped.
   *
   * A second overload rather than a widened `type`, so this stays the statement of exactly which
   * events the renderer is given. Without it the client has nothing to settle a pending request
   * with, and a dead engine is a skeleton that pulses until the user quits.
   */
  addEventListener(type: "close", listener: () => void): void;
  start(): void;
  close(): void;
}

/**
 * What a bug report needs and the renderer cannot work out for itself.
 *
 * Paths and version strings only — never a line of the log. The pane points at the file; opening
 * it is the file manager's job. See `docs/decisions/035`.
 */
export interface DiagnosticsInfo {
  readonly logFile: string;
  readonly directory: string;
  readonly appVersion: string;
  readonly electronVersion: string;
  readonly chromeVersion: string;
  readonly nodeVersion: string;
}

/**
 * One process, once.
 *
 * Already labelled, and deliberately: the renderer has no business knowing that Chromium calls a
 * window a `Tab`, and the name of an engine host is a fact about `hosts.ts`. Main resolves both, so
 * the only thing that crosses is a row someone can read.
 *
 * `cpuPercent` is a percentage of one core, so a busy process reads above 100 and nothing caps it.
 * `memoryKb` is Chromium's working set uncorrected, which counts the shared framework once in every
 * process that maps it; `docs/decisions/040` argues for reporting it that way and saying so in the
 * pane rather than subtracting an estimate nobody can audit.
 */
export interface ProcessReading {
  readonly pid: number;
  readonly label: string;
  readonly cpuPercent: number;
  readonly memoryKb: number;
  readonly peakMemoryKb: number;
}

/** Every process, at one instant. `takenAt` is `Date.now()` in main, and is only ever displayed. */
export interface ResourceSample {
  readonly takenAt: number;
  readonly processes: readonly ProcessReading[];
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
  /**
   * A value, not a call: read synchronously in the preload so the renderer can paint the right
   * colours in its first frame rather than flashing the defaults and correcting itself.
   */
  readonly preferences: Preferences;
  /** Returns an unsubscribe function, so a re-render cannot stack listeners. */
  onHostFailure(listener: (failure: HostFailure) => void): () => void;
  listWorkspaces(): Promise<WorkspaceHandle[]>;
  /** A native directory dialog. `null` when the user cancelled. */
  pickWorkspaceDirectory(): Promise<string | null>;
  /** Ask for a host for `root`. The port arrives through `onEnginePort`. */
  openWorkspace(root: string): Promise<void>;
  /**
   * The workspace the main process decided to reopen at launch, or `null` if it decided not to.
   *
   * The one fact about a workspace that is knowable before any engine port exists, which is what
   * lets the window say "opening" instead of "nothing is open" on a cold start. Stale the moment a
   * port arrives - from then on the session's own `root` is the answer - so read it once.
   */
  reopening(): Promise<string | null>;
  /**
   * Make an empty workspace called `name` in the one place this app puts new ones.
   *
   * A name, never a path: main resolves the home directory and owns every file system call, so
   * the renderer cannot name a destination. `pickWorkspaceDirectory` stays the way to a root
   * that already exists somewhere else.
   */
  createWorkspace(name: string): Promise<CreateWorkspaceResult>;
  forgetWorkspace(root: string): Promise<void>;
  revealInFileManager(target: string): Promise<void>;
  /**
   * A native file dialog for a runner's iteration data. `null` when the user cancelled.
   * The engine resolves whatever comes back, so the dialog does not have to stay inside
   * the workspace: iteration data is commonly kept beside a test suite, not inside it.
   */
  pickDataFile(): Promise<string | null>;
  /**
   * `.proto` files to declare, filtered to the one extension the engine will accept.
   *
   * Multi-select because the task these serve is declaring a repository's protos, and the
   * repositories this was built against carry twenty-four and thirty-five of them. Resolves to
   * an empty array when the user cancelled, so a cancel and a pick of nothing read alike.
   */
  pickProtoFiles(): Promise<string[]>;
  /**
   * A directory to sweep for `.proto` files. The sweep itself is the engine's, not this
   * dialog's — the renderer never walks a file system.
   */
  pickProtoFolder(): Promise<string | null>;
  /**
   * Where a named shared link should point. `name` is only shown, so a machine that is missing
   * three links can be told which one it is being asked about.
   */
  pickCheckout(name: string): Promise<string | null>;
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
  /** Persist the whole preference record. There is no partial update; the record is small. */
  savePreferences(next: Preferences): Promise<void>;
  /**
   * Repaint the native window to match. Separate from `savePreferences` because it is the half
   * that has to happen now, before the next frame, while persistence can take its time.
   */
  setWindowChrome(chrome: WindowChrome): void;
  /** The app menu's Settings item. Returns an unsubscribe function. */
  onOpenSettings(listener: () => void): () => void;
  /**
   * The File menu's Create New Workspace item. Returns an unsubscribe function.
   *
   * A request rather than a result: Electron has no native text-input dialog, so the menu asks the
   * renderer to open the one naming dialog the dropdown and the palette also open.
   */
  onCreateWorkspace(listener: () => void): () => void;
  /** The File menu's Migrate from Postman item. Returns an unsubscribe function. */
  onMigrate(listener: () => void): () => void;
  /**
   * Every cloud workspace the running, signed-in Postman Desktop can see.
   *
   * Nothing is passed in and no token comes back: the credential is harvested inside the engine
   * from the running Postman Desktop, so the renderer never holds one and cannot leak one.
   */
  listPostmanWorkspaces(): Promise<CloudWorkspaceListResult>;
  /**
   * Migrate one cloud workspace into a directory the user picks in a native dialog.
   *
   * The destination is chosen in the main process, never named by the renderer — the same rule
   * `createWorkspace` and `saveReport` follow. The caller opens the result over `openWorkspace`,
   * so migrating adds no host lifecycle of its own.
   */
  migratePostmanWorkspace(workspaceId: string): Promise<MigrateResult>;
  /**
   * How far the running migration has got. Returns an unsubscribe function.
   *
   * Separate from the `invoke` above because that promise settles once, at the end; a migration is
   * about a hundred reports over the better part of a minute, and a window that showed nothing
   * until the last one is a window that looks hung.
   */
  onMigrateProgress(listener: (progress: MigrationProgress) => void): () => void;
  /**
   * Where the log is and what is running, for the Settings pane's Diagnostics section.
   *
   * Read on demand rather than handed over at load: none of it changes while the app runs, but
   * nothing pays for it until someone opens the pane that shows it.
   */
  diagnostics(): Promise<DiagnosticsInfo>;
  /**
   * Every process's CPU and memory, once a second, for the Settings pane's Resources tab. Returns
   * an unsubscribe function.
   *
   * Only arrives between `watchResources(true)` and `watchResources(false)`. Nothing is buffered
   * while nobody is listening, so the first sample after subscribing is the first second measured
   * and not a replay — see `docs/decisions/040` for why a spike you were not watching is gone.
   */
  onResourceSample(listener: (sample: ResourceSample) => void): () => void;
  /**
   * Start or stop sampling. The one thing in this surface the renderer says to make main do work.
   *
   * Paired with the mount and unmount of the tab that draws it, rather than left on: `app.getAppMetrics`
   * walks the process list, and the reading it feeds is a repaint per second of a pane nobody has
   * opened. Decision 017 found 7-16ms of ambient blocking in the idle app already.
   */
  watchResources(watching: boolean): void;
}
