/**
 * A resolved HTTP request as a `curl` argv.
 *
 * Resolves nothing: it takes what {@link import("@preman/core/http/request.js").buildHttpRequest}
 * already returns (decision 9), so there is exactly one truth about what a request is and this
 * module only spells it. The reverse of `import/curl.ts`, and its drop table read backwards.
 */
import type { BuiltHttpRequest } from "@preman/core/http/request.js";
import type { CommandCerts } from "@preman/core/command/plan.js";

export const CURL_COMMAND = "curl";

const GET_METHOD = "GET";
const METHOD_FLAG = "-X";
const HEADER_FLAG = "-H";
const FOLLOW_REDIRECTS_FLAG = "-L";
const DATA_RAW_FLAG = "--data-raw";
const DATA_BINARY_FLAG = "--data-binary";
const FORM_FLAG = "-F";
const CACERT_FLAG = "--cacert";
const CERT_FLAG = "--cert";
const KEY_FLAG = "--key";
const INSECURE_FLAG = "-k";
/** curl reads a leading `@` as "the contents of this file", which is what a file body is. */
const FILE_PREFIX = "@";
const HEADER_SEPARATOR = ": ";
const FORM_SEPARATOR = "=";
/** The generated `Content-Type` of a multipart body, which curl replaces with its own. */
const MULTIPART_CONTENT_TYPE = "multipart/form-data; boundary=";
const CONTENT_TYPE = "content-type";

export const MULTIPART_BOUNDARY_WARNING =
  "curl generates its own multipart boundary, so the bytes will differ from preman's";

/**
 * How the bytes go on a curl command line.
 *
 * Multipart is the one mode that is not byte-exact (decision 32): `-F` per entry hands curl the
 * fields and lets it assemble them, because the alternative — `--data-binary` with preman's
 * whole assembled body, boundary and all — is byte-exact and unusable by a human.
 */
export type CurlBody =
  | { readonly kind: "none" }
  | { readonly kind: "raw"; readonly text: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "form"; readonly entries: readonly CurlFormEntry[] };

export interface CurlFormEntry {
  readonly name: string;
  /** The literal value, or the path when {@link CurlFormEntry.file} is set. */
  readonly value: string;
  readonly file: boolean;
}

export interface RenderCurlOptions {
  readonly body: CurlBody;
  readonly certs: CommandCerts;
}

export interface CurlWords {
  readonly words: readonly string[];
  readonly warnings: readonly string[];
}

function bodyWords(body: CurlBody): string[] {
  switch (body.kind) {
    case "none":
      return [];
    case "raw":
      return [DATA_RAW_FLAG, body.text];
    case "file":
      return [DATA_BINARY_FLAG, `${FILE_PREFIX}${body.path}`];
    case "form":
      return body.entries.flatMap((entry) => [
        FORM_FLAG,
        `${entry.name}${FORM_SEPARATOR}${entry.file ? FILE_PREFIX : ""}${entry.value}`,
      ]);
  }
}

function certWords(certs: CommandCerts): string[] {
  const words: string[] = [];
  if (certs.extraCaCerts !== undefined) words.push(CACERT_FLAG, certs.extraCaCerts);
  if (certs.clientCert !== undefined) words.push(CERT_FLAG, certs.clientCert);
  if (certs.clientKey !== undefined) words.push(KEY_FLAG, certs.clientKey);
  if (certs.insecure) words.push(INSECURE_FLAG);
  return words;
}

/**
 * Render `built` as the argv of a `curl` that makes the same call.
 *
 * `-X` goes on for anything but `GET` even where `--data-raw` would imply `POST` (decision 29),
 * and `-L` always goes on because preman follows redirects by default and curl does not
 * (decision 30). Both are explicitness in a string someone else has to read.
 */
export function renderCurl(built: BuiltHttpRequest, options: RenderCurlOptions): CurlWords {
  const warnings: string[] = [];
  const words: string[] = [CURL_COMMAND];

  if (built.method !== GET_METHOD) words.push(METHOD_FLAG, built.method);

  const multipart = options.body.kind === "form";
  for (const { key, value } of built.headers) {
    // curl picks its own boundary, so preman's generated header would name one that is not
    // in the body curl assembles — a request that fails for a reason the command does not show.
    if (multipart && key.toLowerCase() === CONTENT_TYPE && value.startsWith(MULTIPART_CONTENT_TYPE)) continue;
    words.push(HEADER_FLAG, `${key}${HEADER_SEPARATOR}${value}`);
  }

  words.push(FOLLOW_REDIRECTS_FLAG);
  words.push(...bodyWords(options.body));
  if (multipart) warnings.push(MULTIPART_BOUNDARY_WARNING);
  words.push(...certWords(options.certs));
  words.push(built.url.toString());

  return { words, warnings };
}
