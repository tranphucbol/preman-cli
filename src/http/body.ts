import { CliError } from "../errors.js";
import { interpolateStrict } from "../vars/interpolate.js";
import type { VariableStore } from "../vars/store.js";
import type { HttpRequest } from "../workspace/schemas.js";
import { normalizeKeyValues, type KeyValue } from "./headers.js";

/** `body.type` → default `content-type`. Postman stores the short name only. */
export const BODY_CONTENT_TYPES: Record<string, string> = {
  json: "application/json",
  text: "text/plain",
  xml: "application/xml",
  html: "text/html",
  javascript: "application/javascript",
  urlencoded: "application/x-www-form-urlencoded",
};

/** The one `body.type` whose `content` may be a map or a list instead of text. */
export const URLENCODED_MODE = "urlencoded";

export interface RequestBody {
  /** `body.type`, trimmed and lower-cased; `""` when the request declares none. */
  mode: string;
  /** The authored text payload; `""` when the body is a form. */
  raw: string;
  /** Form fields, in order. Only ever set for a {@link URLENCODED_MODE} body. */
  urlencoded: KeyValue[] | undefined;
}

const EMPTY_BODY: RequestBody = { mode: "", raw: "", urlencoded: undefined };

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
  if (content === undefined) return { mode, raw: "", urlencoded: undefined };
  if (typeof content === "string") return { mode, raw: content, urlencoded: undefined };

  // Any other type with a structured payload is a mistake worth naming: silently
  // serialising it would send bytes the author never wrote.
  if (mode !== URLENCODED_MODE) {
    throw new CliError(`body.content in ${request.url} must be text unless body.type is ${URLENCODED_MODE}`, {
      details: [`body.type is ${mode.length > 0 ? `"${mode}"` : "not set"}`, "write the payload as a string, or set body.type: urlencoded"],
    });
  }

  return { mode, raw: "", urlencoded: normalizeKeyValues(content, `body.content in ${request.url}`) };
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
    if (body.urlencoded.length === 0) return undefined;
    // Interpolated per field, then encoded: a `{{sig}}` holding `a+b` must reach
    // the server as that value, not as two characters the form parser splits on.
    return serializeUrlencoded(
      body.urlencoded.map(({ key, value }) => ({ key, value: interpolateStrict(value, store, `body field "${key}"`) })),
    );
  }

  // Sent verbatim: round-tripping through JSON.parse would reformat the payload and
  // reject the deliberately non-JSON bodies real collections contain.
  return body.raw.length > 0 ? interpolateStrict(body.raw, store, "request body") : undefined;
}
