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
 * How far a failed request got.
 *
 * `build` means preman stopped before anything reached the wire — an unresolved
 * variable, a missing proto, a request it could not parse. `transport` means bytes
 * were sent and the answer was a refusal or a silence.
 *
 * A reader cannot tell these apart from the other fields: neither one has a
 * `response-head` when the protocol is HTTP, and "no response arrived" is the wrong
 * thing to say about a call that was never placed.
 */
export type FailureStage = "build" | "transport";

/**
 * What the engine reports while a run is in flight.
 *
 * Ordered by arrival, not by importance: a GUI paints `request-sent`, then
 * `response-head`, then `response-body`, and fills the console and test lists in as
 * they stream. The batch `RunOutcome` still arrives at the end and is still the
 * authority — these events exist so the window is not blank until it does.
 *
 * `response-failure` is the one variant that exists for the window alone. The CLI
 * prints the refusal out of the batch outcome, or the thrown `PremanError` out of
 * the exit path; a GUI holding only `response-head` and an exit code could paint a
 * red word and nothing else, which is not a report of what went wrong. See
 * `docs/decisions/019-the-failure-crosses-the-wire.md`.
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
  | {
      type: "response-failure";
      runId: string;
      nodeId: string;
      /** How far the request got, which decides how the failure should be described. */
      stage: FailureStage;
      /**
       * Why it failed, verbatim from the server, the socket, or preman itself. Never
       * rewritten and never truncated: it is the one string the reader came for.
       */
      message: string;
      /**
       * Actionable lines belonging to this failure: a TLS handshake hint from the
       * transport, or a `PremanError`'s `details[]` from a build.
       */
      details: string[];
      /** gRPC trailing metadata. Empty for HTTP and for every build failure. */
      trailers: HeaderPairs;
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
