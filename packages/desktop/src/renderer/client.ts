/**
 * The renderer's whole relationship with the engine.
 *
 * There is no `@preman/core` here and there is no `node:*` here. Everything this file
 * can do, it does by asking a port. That constraint is the architecture: if a view can
 * `import { runRequest }`, one eventually will, and the app becomes Postman.
 */
import {
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

export interface EngineClient {
  readonly root: string;
  send<K extends EngineRequestKind>(kind: K, payload: EnginePayload<K>): Promise<EngineResults[K]>;
  /** Returns an unsubscribe function. */
  onPush(listener: PushListener): () => void;
  close(): void;
}

interface Pending {
  resolve(data: unknown): void;
  reject(error: Error): void;
}

export function createEngineClient(root: string, port: EnginePort): EngineClient {
  const pending = new Map<number, Pending>();
  const listeners = new Set<PushListener>();
  let nextId = FIRST_REQUEST_ID;
  let closed = false;

  function settle(response: EngineResponse): void {
    const waiting = pending.get(response.id);
    if (waiting === undefined) return;
    pending.delete(response.id);
    if (response.ok) waiting.resolve(response.data);
    else waiting.reject(new EngineRequestError(response.error));
  }

  port.addEventListener("message", (event) => {
    const message = event.data as EngineMessage;
    if (isEnginePush(message)) {
      for (const listener of listeners) listener(message);
      return;
    }
    settle(message);
  });
  port.start();

  return {
    root,
    send<K extends EngineRequestKind>(kind: K, payload: EnginePayload<K>): Promise<EngineResults[K]> {
      if (closed) return Promise.reject(new Error(`the engine for ${root} is closed`));
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
    close() {
      closed = true;
      for (const waiting of pending.values()) waiting.reject(new Error(`the engine for ${root} closed`));
      pending.clear();
      listeners.clear();
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
