/**
 * The renderer's whole relationship with the engine.
 *
 * There is no `@preman/core` here and there is no `node:*` here. Everything this file
 * can do, it does by asking a port. That constraint is the architecture: if a view can
 * `import { runRequest }`, one eventually will, and the app becomes Postman.
 */
import {
  EXIT_CODES,
  isEnginePush,
  type EngineError,
  type EngineMessage,
  type EnginePayload,
  type EnginePush,
  type EngineRequest,
  type EngineRequestKind,
  type EngineResponse,
  type EngineResults,
  type ExitCode,
} from "@preman/desktop/engine/protocol.js";
import {
  ENGINE_PORT_WINDOW_MESSAGE,
  type EnginePort,
  type EnginePortDelivery,
  type PremanBridge,
} from "@preman/desktop/preload/bridge.js";

const FIRST_REQUEST_ID = 1;

/**
 * What a request that outlived its engine says.
 *
 * An `EngineRequestError` rather than a new class: `toEngineError`, `ResponseFailure` and
 * `HostBanner` already draw that shape, and a second class would be a new branch in each of them
 * for a failure they already know how to render. `TRANSPORT`, because the port is the transport.
 */
export const PORT_CLOSED_MESSAGE = "the engine stopped";
export const PORT_CLOSED_DETAILS = ["the workspace's engine process is gone", "reopen the workspace"] as const;

declare global {
  interface Window {
    readonly preman: PremanBridge;
  }
}

/** An engine failure, rehydrated on this side of the port with its `details[]` intact. */
export class EngineRequestError extends Error {
  readonly details: string[];
  readonly exitCode: ExitCode;

  constructor(error: EngineError) {
    super(error.message);
    this.name = "EngineRequestError";
    this.details = error.details;
    this.exitCode = error.exitCode;
  }
}

export type PushListener = (push: EnginePush) => void;
export type CloseListener = () => void;

export interface EngineClient {
  readonly root: string;
  send<K extends EngineRequestKind>(kind: K, payload: EnginePayload<K>): Promise<EngineResults[K]>;
  /** Returns an unsubscribe function. */
  onPush(listener: PushListener): () => void;
  /**
   * The far end went away by itself. Returns an unsubscribe function.
   *
   * Separate from a rejected `send`, and not redundant with it: a port that dies with nothing in
   * flight — a reap after five idle minutes, most often — has no promise to reject, so this is the
   * only thing that can tell the window its engine is gone. Not called by {@link EngineClient.close},
   * which is this side hanging up on purpose.
   */
  onClose(listener: CloseListener): () => void;
  close(): void;
}

interface Pending {
  resolve(data: unknown): void;
  reject(error: Error): void;
}

/** The rejection every abandoned request gets, built fresh so no two share a stack. */
function portClosedError(): EngineRequestError {
  return new EngineRequestError({
    message: PORT_CLOSED_MESSAGE,
    details: [...PORT_CLOSED_DETAILS],
    exitCode: EXIT_CODES.TRANSPORT,
  });
}

export function createEngineClient(root: string, port: EnginePort): EngineClient {
  const pending = new Map<number, Pending>();
  const listeners = new Set<PushListener>();
  const closeListeners = new Set<CloseListener>();
  let nextId = FIRST_REQUEST_ID;
  let closed = false;

  function settle(response: EngineResponse): void {
    const waiting = pending.get(response.id);
    if (waiting === undefined) return;
    pending.delete(response.id);
    if (response.ok) waiting.resolve(response.data);
    else waiting.reject(new EngineRequestError(response.error));
  }

  /**
   * Abandon everything in flight. Shared by the deliberate close and the far end vanishing,
   * because two loops that must agree is how one of them eventually stops agreeing.
   */
  function rejectPending(): void {
    // Drained before the loop: a `.catch` that calls back into the client must not find the
    // request it is being told about still listed as pending.
    const abandoned = [...pending.values()];
    pending.clear();
    for (const waiting of abandoned) waiting.reject(portClosedError());
  }

  port.addEventListener("message", (event) => {
    const message = event.data as EngineMessage;
    if (isEnginePush(message)) {
      for (const listener of listeners) listener(message);
      return;
    }
    settle(message);
  });

  port.addEventListener("close", () => {
    // Already closed means this side hung up, and the caller who did that already knows.
    if (closed) return;
    closed = true;
    rejectPending();
    const notify = [...closeListeners];
    closeListeners.clear();
    listeners.clear();
    for (const listener of notify) listener();
  });

  port.start();

  return {
    root,
    send<K extends EngineRequestKind>(kind: K, payload: EnginePayload<K>): Promise<EngineResults[K]> {
      // Refused rather than queued at a dead port: a message posted to one is never answered.
      if (closed) return Promise.reject(portClosedError());
      const id = nextId++;
      // The envelope is assembled here so no caller can invent an id.
      const request = { id, kind, ...payload } as unknown as EngineRequest;
      const settled = new Promise<EngineResults[K]>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      port.postMessage(request);
      return settled;
    },
    onPush(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    close() {
      closed = true;
      rejectPending();
      listeners.clear();
      // Not notified: this is the window replacing its own client, not the engine going away.
      closeListeners.clear();
      port.close();
    },
  };
}

/**
 * Wait for the main process to hand this window a port. The port arrives through
 * `window.postMessage` rather than the bridge because a `MessagePort` cannot cross
 * `contextBridge`; see `ENGINE_PORT_WINDOW_MESSAGE`.
 */
export function onEngineClient(listener: (client: EngineClient) => void): () => void {
  const handler = (event: MessageEvent): void => {
    if (event.source !== window) return;
    const delivery = event.data as Partial<EnginePortDelivery> | null;
    if (delivery?.kind !== ENGINE_PORT_WINDOW_MESSAGE) return;
    const port = event.ports[0];
    if (port === undefined || delivery.root === undefined) return;
    listener(createEngineClient(delivery.root, port));
  };

  window.addEventListener("message", handler);
  return () => {
    window.removeEventListener("message", handler);
  };
}
