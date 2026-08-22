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
  windowControl: "preman:window-control",
} as const;

export type WindowControl = "minimise" | "maximise" | "close";

export interface WorkspaceHandle {
  root: string;
  /** The basename, which is what the workspace switcher shows. */
  name: string;
  lastOpenedAt: number;
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
  /** Returns an unsubscribe function, so a re-render cannot stack listeners. */
  onHostFailure(listener: (failure: HostFailure) => void): () => void;
  listWorkspaces(): Promise<WorkspaceHandle[]>;
  /** A native directory dialog. `null` when the user cancelled. */
  pickWorkspaceDirectory(): Promise<string | null>;
  /** Ask for a host for `root`. The port arrives through `onEnginePort`. */
  openWorkspace(root: string): Promise<void>;
  forgetWorkspace(root: string): Promise<void>;
  revealInFileManager(target: string): Promise<void>;
  controlWindow(action: WindowControl): void;
}
