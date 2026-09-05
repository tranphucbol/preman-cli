import { randomBytes } from "node:crypto";
import { basename, extname } from "node:path";
import { PremanError } from "@preman/core/errors.js";
import { maskComments, offendingLine } from "@preman/core/json/comments.js";
import { interpolateStrict } from "@preman/core/vars/interpolate.js";
import type { VariableStore } from "@preman/core/vars/store.js";
import type { Property } from "@preman/core/scripts/property-list.js";
import type { HttpRequest } from "@preman/core/workspace/schemas.js";
import type { FileReader } from "@preman/core/workspace/files.js";
import { normalizeProperties, type KeyValue } from "./headers.js";

export const BODY_CONTENT_TYPES: Record<string, string> = {
  json: "application/json",
  text: "text/plain",
  xml: "application/xml",
  html: "text/html",
  javascript: "application/javascript",
  urlencoded: "application/x-www-form-urlencoded",
  graphql: "application/json",
};

/** The one `body.type` whose `content` may be a map or a list instead of text. */
export const URLENCODED_MODE = "urlencoded";
export const FORM_DATA_MODE = "formdata";
export const FILE_MODE = "file";
export const GRAPHQL_MODE = "graphql";
export const RAW_MODE = "raw";

export interface RequestBody {
  /** `body.type`, trimmed and lower-cased; `""` when the request declares none. */
  mode: string;
  /** The authored text payload; `""` when the body is a form. */
  raw: string;
  /** Form fields, in order. Only ever set for a {@link URLENCODED_MODE} body. */
  urlencoded: Property[] | undefined;
}

const EMPTY_BODY: RequestBody = { mode: "", raw: "", urlencoded: undefined };
/** Variables that are nothing but comments send no `variables` key, the way commenting out the last one reads. */
const COMMENTED_OUT = "";

export interface WireBody {
  /** Bytes to write. `undefined` means no body at all. */
  content: string | Buffer | undefined;
  /** Set only if the request does not already carry a Content-Type. */
  contentType: string | undefined;
}

export interface BuildBodyOptions {
  body: HttpRequest["body"];
  store: VariableStore;
  files: FileReader;
  /** Injected so tests can pin the multipart boundary. */
  boundary?: string;
  /** Request name or URL included in errors. */
  requestLabel?: string;
}

const URLENCODED_CONTENT_TYPE = BODY_CONTENT_TYPES.urlencoded;
const MULTIPART_PREFIX = "multipart/form-data; boundary=";
const BOUNDARY_LEAD = "--------------------------";
const BOUNDARY_BYTES = 12;
const CRLF = "\r\n";
const DEFAULT_FILE_TYPE = "application/octet-stream";
const GRAPHQL_CONTENT_TYPE = "application/json";
const FILE_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

function scalarText(value: string | number | boolean | null | undefined): string {
  return value === undefined || value === null ? "" : String(value);
}

function fileType(path: string): string {
  return FILE_TYPES[extname(path).toLowerCase()] ?? DEFAULT_FILE_TYPE;
}

function escapeDisposition(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

const CONTROL_CHARACTER_RANGE = "\\u0000-\\u001f\\u007f";
const CONTROL_CHARACTER_PATTERN = new RegExp(`[${CONTROL_CHARACTER_RANGE}]`);

function partHeaderValue(value: string, label: string): string {
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new PremanError(`${label} contains a control character that cannot be used in multipart headers`);
  }
  return value;
}

function multipartBody(options: BuildBodyOptions, entries: NonNullable<HttpRequest["body"]>["formdata"]): WireBody {
  const enabled = (entries ?? []).filter((entry) => entry.disabled !== true);
  if (enabled.length === 0) return { content: undefined, contentType: undefined };

  const boundary = options.boundary ?? `${BOUNDARY_LEAD}${randomBytes(BOUNDARY_BYTES).toString("hex")}`;
  const chunks: Buffer[] = [];
  for (const entry of enabled) {
    const name = escapeDisposition(partHeaderValue(entry.key, "formdata field name"));
    chunks.push(Buffer.from(`--${boundary}${CRLF}`));
    if (entry.type === "file") {
      if (entry.src === undefined || entry.src.length === 0) {
        throw new PremanError(`formdata field "${entry.key}" has no file source`);
      }
      const src = interpolateStrict(entry.src, options.store, `formdata field "${entry.key}" source`);
      options.files.resolve(src, `formdata field "${entry.key}"`);
      const filename = escapeDisposition(partHeaderValue(basename(src), `formdata field "${entry.key}" filename`));
      const contentType = partHeaderValue(
        entry.contentType ?? fileType(src),
        `formdata field "${entry.key}" contentType`,
      );
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${name}"; filename="${filename}"${CRLF}` +
            `Content-Type: ${contentType}${CRLF}${CRLF}`,
        ),
        options.files.read(src, `formdata field "${entry.key}"`),
        Buffer.from(CRLF),
      );
    } else {
      const value = interpolateStrict(scalarText(entry.value), options.store, `formdata field "${entry.key}"`);
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`));
    }
  }
  chunks.push(Buffer.from(`--${boundary}--${CRLF}`));
  return { content: Buffer.concat(chunks), contentType: `${MULTIPART_PREFIX}${boundary}` };
}

/** Turn every authored body mode into replayable wire bytes. */
export function buildBody(options: BuildBodyOptions): { wire: WireBody; warnings: string[] } {
  const body = options.body;
  if (body === undefined) return { wire: { content: undefined, contentType: undefined }, warnings: [] };

  const mode = body.type?.trim().toLowerCase() ?? "";
  const warnings: string[] = [];
  if (mode === FORM_DATA_MODE) {
    return { wire: multipartBody(options, body.formdata), warnings };
  }
  if (mode === FILE_MODE) {
    const src = body.file?.src;
    if (src === undefined || src.length === 0)
      return { wire: { content: undefined, contentType: undefined }, warnings };
    const interpolated = interpolateStrict(src, options.store, "file body source");
    options.files.resolve(interpolated, "file body");
    return {
      wire: { content: options.files.read(interpolated, "file body"), contentType: fileType(interpolated) },
      warnings,
    };
  }
  if (mode === GRAPHQL_MODE) {
    const graphql = body.graphql;
    if (graphql === undefined) return { wire: { content: undefined, contentType: undefined }, warnings };
    const query = interpolateStrict(graphql.query, options.store, "GraphQL query");
    let variables: unknown;
    if (graphql.variables !== undefined) {
      const source = interpolateStrict(graphql.variables, options.store, "GraphQL variables");
      // preman parses these to build the payload, so a comment in them is not data — the same
      // side of decision 047's line as a gRPC message, and unlike the raw body just below.
      const masked = maskComments(source);
      // Only a source that had something in it and masks to nothing is treated as absent. A
      // genuinely blank one keeps its old answer, whatever that is; comments are the whole change.
      const allComments = source.trim().length > COMMENTED_OUT.length && masked.trim().length === COMMENTED_OUT.length;
      try {
        variables = allComments ? undefined : JSON.parse(masked);
      } catch (cause) {
        const label = options.requestLabel === undefined ? "request" : `request ${options.requestLabel}`;
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new PremanError(`GraphQL variables in ${label} are not valid JSON`, {
          details: [message, ...offendingLine(source, message)],
        });
      }
    }
    return {
      wire: {
        content: JSON.stringify({ query, ...(variables === undefined ? {} : { variables }) }),
        contentType: GRAPHQL_CONTENT_TYPE,
      },
      warnings,
    };
  }
  if (mode === URLENCODED_MODE && body.urlencoded !== undefined) {
    if (body.content !== undefined) warnings.push("body.content ignored because body.urlencoded is present");
    const entries = normalizeProperties(body.urlencoded, "body.urlencoded").filter((entry) => entry.disabled !== true);
    const content =
      entries.length === 0
        ? undefined
        : serializeUrlencoded(
            entries.map(({ key, value }) => ({
              key,
              value: interpolateStrict(value, options.store, `body field "${key}"`),
            })),
          );
    return { wire: { content, contentType: content === undefined ? undefined : URLENCODED_CONTENT_TYPE }, warnings };
  }

  const parsed = readRequestBody({
    $kind: "http-request",
    url: options.requestLabel ?? "request",
    method: "GET",
    body,
  });
  const content = renderBody(parsed, options.store);
  const contentType = content === undefined || mode.length === 0 ? undefined : BODY_CONTENT_TYPES[mode];
  if (content !== undefined && mode.length > 0 && mode !== RAW_MODE && contentType === undefined) {
    warnings.push(`unknown body type "${mode}"; content sent without a generated Content-Type`);
  }
  return { wire: { content, contentType }, warnings };
}

/**
 * Read `body` off a parsed request without touching variables.
 *
 * Two authoring shapes exist in real workspaces: a text payload, and — for
 * `urlencoded` — a map of form fields. They are kept apart here rather than
 * eagerly serialised, because pre-request scripts read the fields individually
 * through `pm.request.body.urlencoded`.
 */
export function readRequestBody(request: HttpRequest): RequestBody {
  const body = request.body;
  if (body === undefined) return EMPTY_BODY;

  const mode = body.type?.trim().toLowerCase() ?? "";
  const content = body.content;
  if (mode === URLENCODED_MODE && body.urlencoded !== undefined) {
    return { mode, raw: "", urlencoded: normalizeProperties(body.urlencoded, `body.urlencoded in ${request.url}`) };
  }
  if (content === undefined) return { mode, raw: "", urlencoded: undefined };
  if (typeof content === "string") return { mode, raw: content, urlencoded: undefined };

  // Any other type with a structured payload is a mistake worth naming: silently
  // serialising it would send bytes the author never wrote.
  if (mode !== URLENCODED_MODE) {
    throw new PremanError(`body.content in ${request.url} must be text unless body.type is ${URLENCODED_MODE}`, {
      details: [
        `body.type is ${mode.length > 0 ? `"${mode}"` : "not set"}`,
        "write the payload as a string, or set body.type: urlencoded",
      ],
    });
  }

  return { mode, raw: "", urlencoded: normalizeProperties(content, `body.content in ${request.url}`) };
}

/**
 * Percent-encode form fields the way a browser would, so a value carrying `&`,
 * `=` or a space cannot forge extra fields.
 */
export function serializeUrlencoded(entries: readonly KeyValue[]): string {
  return new URLSearchParams(entries.map(({ key, value }): [string, string] => [key, value])).toString();
}

/** Resolve `{{tokens}}` and produce the bytes to send, or `undefined` for no body. */
export function renderBody(body: RequestBody, store: VariableStore): string | undefined {
  if (body.urlencoded !== undefined) {
    const enabled = body.urlencoded.filter((entry) => entry.disabled !== true);
    if (enabled.length === 0) return undefined;
    // Interpolated per field, then encoded: a `{{sig}}` holding `a+b` must reach
    // the server as that value, not as two characters the form parser splits on.
    return serializeUrlencoded(
      enabled.map(({ key, value }) => ({ key, value: interpolateStrict(value, store, `body field "${key}"`) })),
    );
  }

  // Sent verbatim: round-tripping through JSON.parse would reformat the payload and
  // reject the deliberately non-JSON bodies real collections contain.
  return body.raw.length > 0 ? interpolateStrict(body.raw, store, "request body") : undefined;
}
