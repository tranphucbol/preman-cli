/**
 * A resolved unary call as a `grpcurl` argv.
 *
 * The reverse of `import/grpcurl.ts`, and its drop table read backwards: what that module drops
 * with `TLS_REASON` and `INCLUDE_REASON`, this module puts back.
 *
 * Single-dash flags throughout, because grpcurl is a Go program and that is the form it
 * documents; `tokenise` in `import/grpcurl.ts` already records that Go treats `-x` and `--x`
 * alike, so the choice is about what a reader recognises rather than what parses.
 */
import type { ResolvedGrpcCall } from "@preman/core/grpc/call.js";
import type { CommandCerts, Unexpressed } from "@preman/core/command/plan.js";

export const GRPCURL_COMMAND = "grpcurl";

const DATA_FLAG = "-d";
const HEADER_FLAG = "-H";
const PLAINTEXT_FLAG = "-plaintext";
const INSECURE_FLAG = "-insecure";
const CACERT_FLAG = "-cacert";
const CERT_FLAG = "-cert";
const KEY_FLAG = "-key";
const PROTO_FLAG = "-proto";
const IMPORT_PATH_FLAG = "-import-path";
const HEADER_SEPARATOR = ": ";
/** grpcurl's positional is the wire form: `pkg.Service/Method`. */
const WIRE_SEPARATOR = "/";
const DESCRIPTOR_SOURCE = "descriptor";
const SCHEMA_FIELD = "schema";
const MESSAGE_INDENT = undefined;

export const DESCRIPTOR_REASON =
  "preman resolved this method from the request's embedded descriptor, and grpcurl needs a .proto file";
export const DESCRIPTOR_WARNING = "the command will not run as written: grpcurl has no schema for this method";
export const LOCAL_PATHS_WARNING = "-proto and -import-path are paths on this machine";

export interface RenderGrpcurlOptions {
  readonly certs: CommandCerts;
  /** `Resources.includeDirsFor`, asked only when there is a `.proto` to ask about. */
  readonly includeDirsFor: (protoPath: string) => string[];
}

export interface GrpcurlWords {
  readonly words: readonly string[];
  readonly unexpressed: readonly Unexpressed[];
  readonly warnings: readonly string[];
}

function certWords(certs: CommandCerts, tls: boolean): string[] {
  const words: string[] = [];
  if (!tls) {
    words.push(PLAINTEXT_FLAG);
    // The remaining flags are about verifying a TLS peer there is none of.
    return words;
  }
  if (certs.insecure) words.push(INSECURE_FLAG);
  if (certs.extraCaCerts !== undefined) words.push(CACERT_FLAG, certs.extraCaCerts);
  if (certs.clientCert !== undefined) words.push(CERT_FLAG, certs.clientCert);
  if (certs.clientKey !== undefined) words.push(KEY_FLAG, certs.clientKey);
  return words;
}

/** `pkg.Service.Method` back to the wire form, reversing what import's parser flattened. */
function positionalMethod(call: ResolvedGrpcCall): string {
  return [call.method.serviceName, call.method.methodName].join(WIRE_SEPARATOR);
}

export function renderGrpcurl(call: ResolvedGrpcCall, options: RenderGrpcurlOptions): GrpcurlWords {
  const unexpressed: Unexpressed[] = [];
  const warnings: string[] = [];
  const words: string[] = [GRPCURL_COMMAND];

  words.push(DATA_FLAG, JSON.stringify(call.message, null, MESSAGE_INDENT));
  for (const { key, value } of call.metadata) words.push(HEADER_FLAG, `${key}${HEADER_SEPARATOR}${value}`);
  words.push(...certWords(options.certs, call.target.tls));

  const protoPath = call.method.protoPath;
  if (call.method.source === DESCRIPTOR_SOURCE || protoPath === undefined) {
    unexpressed.push({ field: SCHEMA_FIELD, reason: DESCRIPTOR_REASON });
    warnings.push(DESCRIPTOR_WARNING);
  } else {
    words.push(PROTO_FLAG, protoPath);
    for (const dir of options.includeDirsFor(protoPath)) words.push(IMPORT_PATH_FLAG, dir);
    warnings.push(LOCAL_PATHS_WARNING);
  }

  words.push(call.target.authority, positionalMethod(call));
  return { words, unexpressed, warnings };
}
