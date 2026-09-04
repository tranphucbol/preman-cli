/**
 * Validate one request document into the shape its `$kind` promises, whether it came off disk or
 * out of an editor that has not saved yet.
 *
 * Lifted out of `runner.ts`, which was the only reader until `command/` needed one. It lives
 * here rather than being exported from there because importing `runner.ts` to read a file pulls
 * the gRPC and HTTP transports in behind it, and the whole point of a copy is that it never
 * dials anything (ADR 029: the engine loads the resolver, never the transport).
 */
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { ZodError } from "zod";
import { PremanError } from "@preman/core/errors.js";
import type { RequestEntry } from "./collections.js";
import {
  grpcRequestSchema,
  httpRequestSchema,
  otherRequestSchema,
  type GrpcRequest,
  type HttpRequest,
} from "./schemas.js";

export const GRPC_KIND = "grpc-request";
export const HTTP_KIND = "http-request";

/** The `$kind` values preman can invoke. Anything else is reported, never guessed at. */
export const RUNNABLE_KINDS = new Set<string>([GRPC_KIND, HTTP_KIND]);

export type ParsedRequest = { protocol: "grpc"; request: GrpcRequest } | { protocol: "http"; request: HttpRequest };

const FILE_ENCODING = "utf8";
const EMPTY_DOCUMENT = {};
const ROOT_PATH = "<root>";
const PATH_SEPARATOR = ".";

function shapeError(entry: RequestEntry, error: ZodError): PremanError {
  return new PremanError(`unexpected shape in ${entry.filePath}`, {
    details: error.issues.map((i) => `${i.path.join(PATH_SEPARATOR) || ROOT_PATH}: ${i.message}`),
  });
}

/**
 * Validate an already-parsed document, which is the half of the read that does not touch disk.
 *
 * Split out for the command aside, which sits open beside an editor and has to answer for the
 * request as the user has it now. The bytes on disk are one draft behind the moment anything is
 * typed, and a panel that is always on screen showing a command for the previous version is worse
 * than no panel: it is confidently wrong. The caller still passes the `entry`, because an unsaved
 * draft is a draft *of that file* — the path is what an error should name, and the ancestors are
 * still where inherited auth and scripts come from.
 */
export function parseRequestDocument(raw: unknown, entry: RequestEntry): ParsedRequest {
  const kind = (raw as { $kind?: unknown }).$kind;

  if (kind === GRPC_KIND) {
    const parsed = grpcRequestSchema.safeParse(raw);
    if (!parsed.success) throw shapeError(entry, parsed.error);
    return { protocol: "grpc", request: parsed.data };
  }

  if (kind === HTTP_KIND) {
    const parsed = httpRequestSchema.safeParse(raw);
    if (!parsed.success) throw shapeError(entry, parsed.error);
    return { protocol: "http", request: parsed.data };
  }

  const other = otherRequestSchema.safeParse(raw);
  const shown = other.success ? other.data.$kind : String(kind);
  throw new PremanError(`"${entry.name}" is a ${shown}, which preman does not support yet`, {
    details: [`supported kinds: ${[...RUNNABLE_KINDS].join(", ")}`],
  });
}

export function parseRequestFile(entry: RequestEntry): ParsedRequest {
  return parseRequestDocument(parseYaml(readFileSync(entry.filePath, FILE_ENCODING)) ?? EMPTY_DOCUMENT, entry);
}
