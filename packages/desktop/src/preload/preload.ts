/**
 * The whole of the renderer's access to the operating system.
 *
 * Everything here is a named capability with a fixed shape. There is no generic
 * `invoke(channel, ...args)` escape hatch, because one of those is the same thing as
 * `nodeIntegration: true` with extra steps.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  CHANNELS,
  ENGINE_PORT_WINDOW_MESSAGE,
  TITLE_BAR_GUTTER_PX,
  type EnginePortDelivery,
  type HostFailure,
  type PremanBridge,
  type SessionSnapshot,
  type WindowControl,
  type WorkspaceHandle,
} from "@preman/desktop/preload/bridge.js";

const BRIDGE_KEY = "preman";
const ANY_ORIGIN = "*";
const FIRST_PORT = 0;
const FRAMELESS_PLATFORM = "darwin";
const NO_GUTTER = 0;

/**
 * The one DOM capability a preload needs. Declared rather than pulling `lib.dom` into
 * a program that also holds the main process, which has no business having a `window`.
 */
interface TransferringWindow {
  postMessage(message: unknown, targetOrigin: string, transfer: readonly unknown[]): void;
}

/**
 * `IpcRendererEvent.ports` is `MessagePort[]`, a DOM type this program has no `lib` for. The port
 * is only ever forwarded, never used here, so the narrowest honest type is an opaque one.
 */
interface PortCarryingEvent {
  readonly ports: readonly unknown[];
}

const bridge: PremanBridge = {
  // Read here rather than over a channel: it cannot change while the window is open, and a
  // title bar that lays itself out one paint late would shift under the pointer.
  titleBarGutter: process.platform === FRAMELESS_PLATFORM ? TITLE_BAR_GUTTER_PX : NO_GUTTER,
  onHostFailure(listener) {
    const handler = (_event: IpcRendererEvent, failure: HostFailure): void => {
      listener(failure);
    };
    ipcRenderer.on(CHANNELS.hostFailure, handler);
    return () => {
      ipcRenderer.off(CHANNELS.hostFailure, handler);
    };
  },
  listWorkspaces: () => ipcRenderer.invoke(CHANNELS.listWorkspaces) as Promise<WorkspaceHandle[]>,
  pickWorkspaceDirectory: () => ipcRenderer.invoke(CHANNELS.pickWorkspace) as Promise<string | null>,
  openWorkspace: (root: string) => ipcRenderer.invoke(CHANNELS.openWorkspace, root) as Promise<void>,
  forgetWorkspace: (root: string) => ipcRenderer.invoke(CHANNELS.forgetWorkspace, root) as Promise<void>,
  revealInFileManager: (target: string) => ipcRenderer.invoke(CHANNELS.revealInFileManager, target) as Promise<void>,
  pickDataFile: () => ipcRenderer.invoke(CHANNELS.pickDataFile) as Promise<string | null>,
  saveReport: (suggestedName: string, text: string) =>
    ipcRenderer.invoke(CHANNELS.saveReport, suggestedName, text) as Promise<string | null>,
  controlWindow: (action: WindowControl) => {
    ipcRenderer.send(CHANNELS.windowControl, action);
  },
  readSession: (root: string) => ipcRenderer.invoke(CHANNELS.readSession, root) as Promise<SessionSnapshot>,
  saveSession: (root: string, snapshot: SessionSnapshot) =>
    ipcRenderer.invoke(CHANNELS.saveSession, root, snapshot) as Promise<void>,
};

contextBridge.exposeInMainWorld(BRIDGE_KEY, bridge);

// The port itself goes the other way: `contextBridge` cannot carry a `MessagePort`,
// `window.postMessage` can. The renderer listens for this tag and takes `event.ports[0]`.
ipcRenderer.on(CHANNELS.enginePort, (event: IpcRendererEvent, payload: { root: string }) => {
  const port = (event as unknown as PortCarryingEvent).ports[FIRST_PORT];
  if (port === undefined) return;
  const delivery: EnginePortDelivery = { kind: ENGINE_PORT_WINDOW_MESSAGE, root: payload.root };
  (globalThis as unknown as TransferringWindow).postMessage(delivery, ANY_ORIGIN, [port]);
});
