import * as grpc from "@grpc/grpc-js";
import type { MethodDefinition } from "@grpc/proto-loader";
import type { Property } from "@/scripts/property-list.js";
import { grpcChannelCredentials, tlsFailureHints, type TlsCertOptions } from "@/tls/certs.js";
import type { GrpcTarget } from "./target.js";

export interface InvokeOptions {
  target: GrpcTarget;
  method: MethodDefinition<unknown, unknown>;
  message: unknown;
  /** Request metadata (already interpolated). */
  metadata?: Property[];
  /** Deadline for the call, in milliseconds. */
  timeoutMs: number;
  /** Resolved certificate material; inert unless the target is TLS. */
  tlsCerts: TlsCertOptions;
}

export interface InvokeResult {
  ok: boolean;
  code: grpc.status;
  /** Symbolic gRPC status, e.g. `OK`, `UNAVAILABLE`. */
  codeName: string;
  /** Server error message; empty on success. */
  message: string;
  response: unknown;
  /** Wall-clock duration of the call in milliseconds. */
  durationMs: number;
  metadata: Record<string, string | string[]>;
  trailers: Record<string, string | string[]>;
  /** Advice about the failure, e.g. which certificate flag would fix it. */
  warnings: string[];
}

function flatten(md: grpc.Metadata | undefined): Record<string, string | string[]> {
  if (!md) return {};
  const out: Record<string, string | string[]> = {};
  for (const [key, values] of Object.entries(md.getMap())) {
    out[key] = Array.isArray(values) ? values.map(String) : String(values);
  }
  return out;
}

function buildMetadata(entries: Property[] | undefined): grpc.Metadata {
  const md = new grpc.Metadata();
  for (const { key, value } of entries ?? []) {
    if (key.length === 0) continue;
    md.add(key.toLowerCase(), value);
  }
  return md;
}

/**
 * Perform a single unary call.
 *
 * Uses the base `grpc.Client` with `makeUnaryRequest` and the serialisers taken
 * straight off the {@link MethodDefinition}. That avoids generating a client
 * constructor and behaves identically for file-loaded and descriptor-loaded
 * schemas.
 *
 * Resolves for both success and gRPC-level failure — a non-OK status is a result,
 * not an exception. The promise only rejects if the client cannot be constructed.
 */
export function invokeUnary(options: InvokeOptions): Promise<InvokeResult> {
  const { target, method, timeoutMs } = options;
  const client = new grpc.Client(target.authority, grpcChannelCredentials(options.tlsCerts, target.tls));

  return new Promise<InvokeResult>((settle) => {
    const startedAt = process.hrtime.bigint();
    const elapsedMs = () => Number(process.hrtime.bigint() - startedAt) / 1e6;

    let responseMetadata: grpc.Metadata | undefined;
    let trailingMetadata: grpc.Metadata | undefined;

    const call = client.makeUnaryRequest<unknown, unknown>(
      method.path,
      method.requestSerialize,
      method.responseDeserialize,
      options.message,
      buildMetadata(options.metadata),
      { deadline: Date.now() + timeoutMs },
      (error, response) => {
        const durationMs = elapsedMs();
        client.close();

        if (error) {
          const code = error.code ?? grpc.status.UNKNOWN;
          settle({
            ok: false,
            code,
            codeName: grpc.status[code] ?? String(code),
            message: error.details || error.message,
            response: undefined,
            durationMs,
            metadata: flatten(responseMetadata),
            trailers: flatten(error.metadata ?? trailingMetadata),
            warnings: tlsFailureHints(error),
          });
          return;
        }

        settle({
          ok: true,
          code: grpc.status.OK,
          codeName: "OK",
          message: "",
          response,
          durationMs,
          metadata: flatten(responseMetadata),
          trailers: flatten(trailingMetadata),
          warnings: [],
        });
      },
    );

    call.on("metadata", (md: grpc.Metadata) => {
      responseMetadata = md;
    });
    call.on("status", (status: grpc.StatusObject) => {
      trailingMetadata = status.metadata;
    });
    // The unary callback already reports failures; this listener exists only so
    // grpc-js does not emit an unhandled 'error' event on the call object.
    call.on("error", () => {});
  });
}
