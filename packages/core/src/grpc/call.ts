/**
 * Everything a unary gRPC call is, resolved and stopped short of the wire.
 *
 * The half of `runGrpcRequest` (`runner.ts`) that runs before the script sink, lifted out so a
 * caller that only wants to *describe* the call — `command/grpcurl.ts` — does not have to invoke
 * one to find out what it would be. `runner.ts` deliberately still has its own copy for the
 * length of plan 028: collapsing them touches the one function ADR 039 is about, under a feature
 * that does not send.
 *
 * One pass, not two. ADR 039's second resolution exists because a pre-request script may set a
 * variable the request then uses; there are no scripts here, so there is nothing to resolve
 * around.
 */
import { applyGrpcAuth } from "./auth.js";
import { resolveMethod, type ResolvedMethod } from "./schema.js";
import { resolveTarget, type GrpcTarget } from "./target.js";
import { PremanError } from "@preman/core/errors.js";
import { normalizeProperties, type KeyValue } from "@preman/core/http/headers.js";
import { PropertyList } from "@preman/core/scripts/property-list.js";
import type { VariableStore } from "@preman/core/vars/store.js";
import { resolveList, Template } from "@preman/core/vars/template.js";
import type { RequestEntry } from "@preman/core/workspace/collections.js";
import { resolveAuth, type ResolvedAuth } from "@preman/core/workspace/inherit.js";
import type { GrpcRequest } from "@preman/core/workspace/schemas.js";

/** Metadata is a `PropertyList` only so `applyGrpcAuth` can write into it; it is never scripted. */
const METADATA_LIST_OPTIONS = { caseInsensitive: true, label: "request metadata" } as const;
const METADATA_LABEL = "metadata";
const EMPTY_MESSAGE = {};
/**
 * The url and the method path are read before anything could rescue them - one has to name a
 * host, the other a method in a schema - so a literal token in either is an error here.
 */
const STRICT = { strict: true } as const;

export interface ResolveGrpcCallOptions {
  readonly entry: RequestEntry;
  readonly request: GrpcRequest;
  readonly store: VariableStore;
  /** Read for `config/application-local.yml` when the request names no host. */
  readonly workspaceRoot: string;
  readonly urlOverride?: string | undefined;
  readonly tlsOverride?: boolean | undefined;
  readonly includeDirsFor: (protoPath: string) => string[];
  readonly preferDescriptor?: boolean | undefined;
}

export interface ResolvedGrpcCall {
  readonly target: GrpcTarget;
  readonly method: ResolvedMethod;
  /** The resolved `methodPath`, in whichever form the file wrote it. */
  readonly methodPath: string;
  /** Enabled entries only, keys lowercased as they go on the wire. */
  readonly metadata: readonly KeyValue[];
  readonly message: unknown;
  readonly auth: ResolvedAuth | undefined;
  readonly warnings: readonly string[];
}

export function resolveGrpcCall(options: ResolveGrpcCallOptions): ResolvedGrpcCall {
  const { entry, request, store } = options;
  const warnings: string[] = [];

  const methodPath = new Template(request.methodPath, store, "methodPath", STRICT).resolved;
  // With --url the authored one is never read, so an unresolvable {{grpc_url}} must not block it.
  const override = options.urlOverride;
  const authoredUrl = override ?? new Template(request.url, store, "url", STRICT).resolved;
  const target = resolveTarget({
    url: authoredUrl,
    workspaceRoot: options.workspaceRoot,
    override: options.urlOverride,
    tlsOverride: options.tlsOverride,
  });

  // Flattened first, so a map-shaped `metadata:` reaches the wire the same as the array form.
  const authored = resolveList(normalizeProperties(request.metadata, METADATA_LABEL), store, (key) =>
    [METADATA_LABEL, key].join("."),
  );
  const metadata = new PropertyList(authored.entries, METADATA_LIST_OPTIONS);

  const auth = resolveAuth(entry, request.auth);
  const authWarnings = applyGrpcAuth({ auth: auth?.auth, metadata, store });
  if (auth !== undefined && auth.origin.level !== "request") {
    authWarnings.unshift(`auth inherited from ${auth.origin.label}`);
  }
  warnings.push(...authWarnings);

  const raw = new Template(request.message?.content ?? "", store, "message body").resolved;
  let message: unknown = EMPTY_MESSAGE;
  if (raw.trim().length > 0) {
    try {
      message = JSON.parse(raw);
    } catch (cause) {
      throw new PremanError(`request body is not valid JSON: ${(cause as Error).message}`);
    }
  }

  const method = resolveMethod({
    requestFilePath: entry.filePath,
    schemaLocation: request.schema?.location,
    methodDescriptor: request.methodDescriptor,
    methodPath,
    includeDirsFor: options.includeDirsFor,
    preferDescriptor: options.preferDescriptor,
  });
  warnings.push(...method.warnings);

  return {
    target,
    method,
    methodPath,
    metadata: metadata.enabled().map((entry_) => ({ key: entry_.key.toLowerCase(), value: entry_.value })),
    message,
    auth,
    warnings,
  };
}
