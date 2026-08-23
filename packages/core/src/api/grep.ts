/**
 * Workspace-wide search, over documents rather than over lines.
 *
 * `grep -r postman/` already works, and it is what people do today. What it cannot tell
 * you is *which field* it hit, so a result is a file and a line number you then have to
 * go and interpret. This walks the parsed YAML instead and reports the key path to the
 * scalar that matched, which is what lets a click land on the Body tab rather than on
 * the top of a file.
 *
 * It is a plain case-insensitive substring, deliberately not a regular expression: a
 * search box where `.` silently means "any character" is a trap, and nothing about a
 * workspace search needs one.
 */
import { readFileSync } from "node:fs";
import { isMap, isScalar, isSeq, parseDocument, LineCounter, type Scalar } from "yaml";
import type { Catalog, CatalogNode } from "@preman/core/api/catalog.js";
import { definitionPathFor, nodeIdFor } from "@preman/core/workspace/paths.js";

/**
 * How many matches a search returns. A global search is a navigation aid, not a report:
 * past a couple of hundred rows the answer is "narrow the query", and the cap is what
 * keeps one careless single letter from walking every byte of every file.
 */
export const GREP_MATCH_LIMIT = 200;

/** How much of a matching line is carried back. */
const PREVIEW_LIMIT = 160;
/** How much of the line before the match is kept, so a hit is never flush against the edge. */
const PREVIEW_LEAD = 24;
/** Joins a field path when one is only needed as a key, never for display. */
const FIELD_SEPARATOR = ".";

/**
 * Fields whose contents are not text a human searches.
 *
 * `methodDescriptor` is a base64 `FileDescriptorSet` — tens of kilobytes of one line, in
 * every gRPC request that carries one. Any two-letter query would match all of them and
 * bury every real result, and the app never shows or rewrites those bytes anyway.
 */
const SKIPPED_FIELDS = new Set(["methodDescriptor"]);

export interface GrepMatch {
  /** The node whose file matched, so a caller can open it without a path lookup. */
  nodeId: string;
  file: string;
  /** The YAML key path to the scalar that matched, e.g. `["message", "content"]`. */
  fieldPath: (string | number)[];
  /** Whether the query hit a key or a value. A key hit means "this field exists here". */
  where: "key" | "value";
  /** 1-based, so it reads the way an editor's gutter does. */
  line: number;
  /** The matching line, clipped to a window around the hit. */
  preview: string;
  /** Where the match starts inside {@link preview}, for highlighting. */
  offset: number;
}

export interface GrepResult {
  matches: readonly GrepMatch[];
  /** True when {@link GREP_MATCH_LIMIT} stopped the search short of the end. */
  truncated: boolean;
  /** A file that could not be read or parsed. Never silent: it holds results back. */
  warnings: readonly string[];
}

const EMPTY: GrepResult = { matches: [], truncated: false, warnings: [] };

/** Where a node's searchable bytes live: a group's text is its definition, not its directory. */
function fileOf(node: CatalogNode): string {
  return node.kind === "request" ? node.file : definitionPathFor(node.file);
}

interface Hit {
  path: (string | number)[];
  where: "key" | "value";
  /** Absolute offset into the file, from the scalar's own source range. */
  start: number;
}

/**
 * Every place the query appears in one scalar's *source*.
 *
 * Source rather than parsed value, because the offsets have to point back into the file
 * for the line and the preview to be real. It also means a query matches what the author
 * typed — `{{greeting}}` inside a quoted string is found as written — and that a match
 * inside a `|-` block reports the line it is actually on rather than the block's first.
 */
function hitsInScalar(
  text: string,
  needle: string,
  node: Scalar,
  path: (string | number)[],
  where: "key" | "value",
  out: Hit[],
): void {
  const range = node.range;
  if (range === null || range === undefined) return;

  const [start, end] = range;
  const source = text.slice(start, end).toLowerCase();
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + needle.length)) {
    out.push({ path, where, start: start + at });
  }
}

/**
 * Walk the document, carrying the key path down.
 *
 * `yaml`'s own `visit` hands back an ancestor list without the sequence indices, and a
 * field path missing its indices cannot address a header row. So the walk is explicit.
 */
function walk(text: string, needle: string, node: unknown, path: (string | number)[], out: Hit[]): void {
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = isScalar(pair.key) ? String(pair.key.value) : undefined;
      if (key === undefined) continue;
      if (SKIPPED_FIELDS.has(key)) continue;
      const child = [...path, key];
      if (isScalar(pair.key)) hitsInScalar(text, needle, pair.key, child, "key", out);
      walk(text, needle, pair.value, child, out);
    }
    return;
  }
  if (isSeq(node)) {
    node.items.forEach((item, index) => {
      walk(text, needle, item, [...path, index], out);
    });
    return;
  }
  if (isScalar(node)) hitsInScalar(text, needle, node, path, "value", out);
}

/** The line a hit is on, clipped to a window, plus where the hit sits inside that window. */
function preview(text: string, counter: LineCounter, hit: Hit): { line: number; preview: string; offset: number } {
  const { line, col } = counter.linePos(hit.start);
  const lineStart = counter.lineStarts[line - 1] ?? 0;
  const lineEnd = counter.lineStarts[line] ?? text.length;
  const body = text.slice(lineStart, lineEnd).replace(/\r?\n$/, "");

  // A base64 blob or a long minified body would otherwise send a whole line across the
  // wire for one hit, so the window follows the match instead of starting at the margin.
  const from = Math.max(0, col - 1 - PREVIEW_LEAD);
  return { line, preview: body.slice(from, from + PREVIEW_LIMIT), offset: col - 1 - from };
}

function searchFile(
  root: string,
  file: string,
  needle: string,
  limit: number,
  matches: GrepMatch[],
  warnings: string[],
): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    // A group with no definition file is normal, and a node whose file has just been
    // deleted is a race with the watcher. Neither is worth a warning.
    return;
  }

  const counter = new LineCounter();
  const document = parseDocument(text, { lineCounter: counter });
  if (document.errors.length > 0) {
    warnings.push(`cannot search ${nodeIdFor(root, file)}: ${document.errors[0]!.message}`);
    return;
  }

  const hits: Hit[] = [];
  walk(text, needle, document.contents, [], hits);

  const nodeId = nodeIdFor(root, file);
  const seen = new Set<string>();
  for (const hit of hits) {
    if (matches.length >= limit) return;
    const located = preview(text, counter, hit);
    // One row per field per line, the way grep counts lines rather than occurrences: a
    // token repeated eight times on one line is one place to go and look, not eight rows
    // that all scroll to the same spot.
    const at = `${hit.where}:${hit.path.join(FIELD_SEPARATOR)}:${String(located.line)}`;
    if (seen.has(at)) continue;
    seen.add(at);
    matches.push({ nodeId, file, fieldPath: hit.path, where: hit.where, ...located });
  }
}

/**
 * Search every request and group definition in a catalog.
 *
 * The catalog is taken rather than re-walked: whoever is asking already holds one, and a
 * second directory walk per keystroke is the cost this whole phase exists to avoid.
 */
export function grepWorkspace(catalog: Catalog, query: string, options: { limit?: number } = {}): GrepResult {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return EMPTY;

  const limit = options.limit ?? GREP_MATCH_LIMIT;
  const matches: GrepMatch[] = [];
  const warnings: string[] = [];

  for (const node of catalog.nodes) {
    if (matches.length >= limit) break;
    searchFile(catalog.root, fileOf(node), needle, limit, matches, warnings);
  }

  // Truncation is reported rather than implied, because "200 results" and "the first 200
  // of many" are different answers to the same query.
  return { matches, truncated: matches.length >= limit, warnings };
}
