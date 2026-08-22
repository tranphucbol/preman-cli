import type { ExitCode } from "@preman/core/errors.js";
import type { ConsoleLine, SideRequestRecord, TestResult } from "@preman/core/scripts/sandbox.js";

/**
 * A header or metadata map flattened for the wire.
 *
 * Pairs rather than an object because a repeated header is normal and legal, and
 * `Record<string, string | string[]>` forces every consumer to branch on the value
 * type before it can render a row.
 */
export type HeaderPairs = [string, string][];

/**
 * What the engine reports while a run is in flight.
 *
 * Ordered by arrival, not by importance: a GUI paints `request-sent`, then
 * `response-head`, then `response-body`, and fills the console and test lists in as
 * they stream. The batch `RunOutcome` still arrives at the end and is still the
 * authority — these events exist so the window is not blank until it does.
 *
 * Every variant carries `runId` so two concurrent runs cannot be interleaved by
 * mistake, and every per-request variant carries `nodeId`, which is the same string
 * as the corresponding `CatalogNode.id`.
 */
export type RunEvent =
  | { type: "run-start"; runId: string; total: number }
  | { type: "request-start"; runId: string; nodeId: string; name: string; iteration: number }
  | { type: "request-sent"; runId: string; nodeId: string; target: string; sent: unknown }
  | {
      type: "response-head";
      runId: string;
      nodeId: string;
      /** An HTTP status code, or a symbolic gRPC status such as `OK`. */
      status: number | string;
      headers: HeaderPairs;
      timings: Record<string, number>;
    }
  | {
      type: "response-body";
      runId: string;
      nodeId: string;
      /** Key into the engine host's `BodyStore`; the body itself never travels. */
      handle: string;
      byteLength: number;
      contentType: string | null;
      preview: string;
      /** True when `preview` stops short of `byteLength` and more must be fetched. */
      truncated: boolean;
    }
  | { type: "console"; runId: string; nodeId: string; line: ConsoleLine }
  | { type: "test"; runId: string; nodeId: string; result: TestResult }
  | { type: "side-request"; runId: string; nodeId: string; summary: SideRequestRecord }
  | { type: "request-end"; runId: string; nodeId: string; exitCode: ExitCode; returnCode?: string }
  | { type: "run-end"; runId: string; exitCode: ExitCode };

/**
 * Where run events go. Supplied by whatever is watching; omitted by the CLI, which
 * waits for the batch outcome and would have nothing to do with a half-finished one.
 *
 * The sink owns `runId` rather than each caller passing it alongside, so an event can
 * never be stamped with an id belonging to a different run.
 */
export interface RunEventSink {
  readonly runId: string;
  emit(event: RunEvent): void;
}

/** Collapse a header or metadata map into wire pairs, repeating repeated keys. */
export function flattenHeaders(headers: Record<string, string | string[]>): HeaderPairs {
  const pairs: HeaderPairs = [];
  for (const [key, value] of Object.entries(headers)) {
    for (const item of Array.isArray(value) ? value : [value]) pairs.push([key, item]);
  }
  return pairs;
}
