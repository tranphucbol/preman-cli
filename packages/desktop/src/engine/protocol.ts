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
import type { RunEvent } from "@preman/core/api/events.js";
import type { SnapshotEnvironment } from "@preman/core/api/inspect.js";
import type { FieldEdit, RequestKind } from "@preman/core/api/mutate.js";
import type { ExitCode } from "@preman/core/errors.js";

export type {
  BodyHead,
  BodyMatch,
  BodyWindow,
  Catalog,
  CatalogNode,
  CatalogNodeKind,
  CatalogProtocol,
  ExitCode,
  FieldEdit,
  RequestKind,
  RunEvent,
  SnapshotEnvironment,
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
  environment?: string;
  iterationCount?: number;
  /** A JSON or CSV path, resolved by the engine against the workspace. */
  iterationData?: string;
  bail?: boolean;
  delayRequestMs?: number;
  timeoutMs?: number;
}

/**
 * A run is acknowledged before it starts and reported through pushes, so a caller
 * can correlate events with a run it has not finished issuing. The outcome is not
 * here: the events are the result, and `run-done` is the terminal signal.
 */
export interface RunAcknowledgement {
  runId: string;
}

export type EngineRequest =
  | { id: number; kind: "catalog" }
  | { id: number; kind: "read-node"; nodeId: string }
  | { id: number; kind: "write-node"; nodeId: string; edits: FieldEdit[] }
  | { id: number; kind: "write-text"; nodeId: string; text: string }
  | { id: number; kind: "mutate"; op: MutateOp }
  | { id: number; kind: "run"; args: RunArgs }
  | { id: number; kind: "cancel"; runId: string }
  | { id: number; kind: "body-head"; handle: string }
  | { id: number; kind: "body-window"; handle: string; offset: number; length?: number }
  | { id: number; kind: "body-search"; handle: string; query: string; limit?: number }
  | { id: number; kind: "body-format"; handle: string }
  | { id: number; kind: "body-release"; handle: string };

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
  "body-head": BodyHead;
  "body-window": BodyWindow;
  "body-search": BodyMatch[];
  "body-format": string;
  "body-release": null;
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
