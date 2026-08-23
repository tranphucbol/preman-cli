import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseDocument, stringify, type Document } from "yaml";
import type { ZodTypeAny } from "zod";
import { EXIT, PremanError } from "@preman/core/errors.js";
import { writeFileAtomic } from "@preman/core/workspace/atomic.js";
import {
  collectionsDirFor,
  definitionPathFor,
  environmentPathFor,
  environmentsDirFor,
  groupPathFor,
  nextOrder,
  requestPathFor,
  sanitiseSegment,
  DEFINITION_FILE,
  ENVIRONMENT_SUFFIX,
  REQUEST_SUFFIX,
} from "@preman/core/workspace/paths.js";
import {
  grpcRequestSchema,
  environmentSchema,
  groupDefinitionSchema,
  httpRequestSchema,
  otherRequestSchema,
} from "@preman/core/workspace/schemas.js";

export type RequestKind = "http-request" | "grpc-request";

const GRPC_KIND = "grpc-request";
const HTTP_KIND = "http-request";
const COLLECTION_KIND = "collection";
const DEFAULT_HTTP_METHOD = "GET";
const DEFAULT_HTTP_URL = "";
const DEFAULT_GRPC_METHOD_PATH = "";
const NAME_KEY = "name";
const ORDER_KEY = "order";

/** One assignment into a parsed document, addressed the way `yaml` addresses nodes. */
export interface FieldEdit {
  path: (string | number)[];
  /** `undefined` deletes the key, and takes any comments attached to it. */
  value: unknown;
}

function usage(message: string, details: string[]): PremanError {
  return new PremanError(message, { exitCode: EXIT.CLI, details });
}

function readDocument(file: string): Document.Parsed {
  let doc: Document.Parsed;
  try {
    doc = parseDocument(readFileSync(file, "utf8"));
  } catch (cause) {
    throw usage(`failed to read ${file}`, [(cause as Error).message]);
  }
  if (doc.errors.length > 0) {
    throw usage(
      `failed to parse ${file}`,
      doc.errors.map((error) => error.message),
    );
  }
  return doc;
}

/**
 * Check a document against the schema its reader will use on it.
 *
 * Called before every write, so an edit that would produce a file the engine cannot
 * read fails while the original is still on disk.
 */
function validateAgainst(file: string, doc: Document, schema: ZodTypeAny): void {
  const parsed = schema.safeParse(doc.toJS() ?? {});
  if (parsed.success) return;
  throw usage(`the edit would make ${basename(file)} unreadable`, [
    ...parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    "the original file was left untouched",
  ]);
}

/** The request schemas keyed exactly as `runner.ts` keys them, so validation agrees with running. */
function requestSchemaFor(doc: Document): ZodTypeAny {
  const kind = (doc.toJS() as { $kind?: unknown } | null)?.$kind;
  if (kind === GRPC_KIND) return grpcRequestSchema;
  if (kind === HTTP_KIND) return httpRequestSchema;
  return otherRequestSchema;
}

function validateRequest(file: string, doc: Document): void {
  validateAgainst(file, doc, requestSchemaFor(doc));
}

function validateDefinition(file: string, doc: Document): void {
  validateAgainst(file, doc, groupDefinitionSchema);
}

function validateEnvironment(file: string, doc: Document): void {
  validateAgainst(file, doc, environmentSchema);
}

function applyEdits(doc: Document, edits: readonly FieldEdit[]): void {
  for (const edit of edits) {
    if (edit.path.length === 0) throw usage("an edit must name a field", ["the empty path addresses the document"]);
    if (edit.value === undefined) doc.deleteIn(edit.path);
    else doc.setIn(edit.path, edit.value);
  }
}

/**
 * Apply field edits to a request file in place.
 *
 * Goes through `parseDocument` rather than `parse` + `stringify` so comments, key
 * order and block-scalar style survive. A gRPC request's base64 `methodDescriptor`
 * is therefore preserved byte for byte, because nothing rewrites the node.
 */
export function editRequestFile(file: string, edits: readonly FieldEdit[]): Promise<void> {
  const doc = readDocument(file);
  applyEdits(doc, edits);
  validateRequest(file, doc);
  writeFileAtomic(file, doc.toString());
  return Promise.resolve();
}

/** Apply field edits to a collection's or folder's `.resources/definition.yaml`. */
export function editDefinitionFile(file: string, edits: readonly FieldEdit[]): Promise<void> {
  const doc = readDocument(file);
  applyEdits(doc, edits);
  validateDefinition(file, doc);
  writeFileAtomic(file, doc.toString());
  return Promise.resolve();
}

/** The schema a file's own reader will use on it, chosen by where the file sits. */
function validateForPath(file: string, doc: Document): void {
  if (isRequestFile(file)) {
    validateRequest(file, doc);
    return;
  }
  if (isEnvironmentFile(file)) {
    validateEnvironment(file, doc);
    return;
  }
  if (basename(file) === DEFINITION_FILE) {
    validateDefinition(file, doc);
    return;
  }
  throw usage(`${basename(file)} is not a request, environment or definition file`, [
    "only files the engine reads can be written",
  ]);
}

/**
 * Replace a file's whole text, validated the same way an edit is.
 *
 * A raw-YAML editor has no field edits to apply, but it must still be refused when it
 * would produce a file the engine cannot read. The bytes written are the bytes given:
 * re-serialising the user's own document is exactly what a raw tab exists to avoid.
 */
export function replaceFileText(file: string, text: string): Promise<void> {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw usage(
      `the text is not valid YAML for ${basename(file)}`,
      doc.errors.map((error) => error.message),
    );
  }
  validateForPath(file, doc);
  writeFileAtomic(file, text);
  return Promise.resolve();
}

/**
 * The smallest document that satisfies the schema for `kind`.
 *
 * Serialised through `stringify` rather than assembled as text: a new file has no
 * comments to preserve, and hand-rolled quoting is how a name with a colon in it
 * produces an unparseable file.
 */
function skeletonFor(kind: RequestKind, name: string, order: number): string {
  const shape =
    kind === GRPC_KIND
      ? { methodPath: DEFAULT_GRPC_METHOD_PATH, url: DEFAULT_HTTP_URL }
      : { url: DEFAULT_HTTP_URL, method: DEFAULT_HTTP_METHOD };
  return stringify({ $kind: kind, [NAME_KEY]: name, ...shape, [ORDER_KEY]: order });
}

/** The declared `order` of everything already in `dir`, requests and subfolders alike. */
function siblingOrders(dir: string): (number | undefined)[] {
  if (!existsSync(dir)) return [];
  const orders: (number | undefined)[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const file = entry.isDirectory() ? definitionPathFor(join(dir, entry.name)) : join(dir, entry.name);
    if (entry.isFile() && !entry.name.endsWith(REQUEST_SUFFIX)) continue;
    if (!existsSync(file)) {
      orders.push(undefined);
      continue;
    }
    const raw: unknown = readDocument(file).toJS();
    const order = (raw as { order?: unknown } | null)?.order;
    orders.push(typeof order === "number" ? order : undefined);
  }
  return orders;
}

export interface CreateRequestArgs {
  parentDir: string;
  name: string;
  kind: RequestKind;
  /** Omitted means "last", derived from the highest declared sibling order. */
  order?: number;
}

/** Write a minimal but valid request file, returning the path actually used. */
export function createRequestFile(args: CreateRequestArgs): Promise<string> {
  if (!existsSync(args.parentDir)) {
    throw usage(`${args.parentDir} does not exist`, ["create the folder or collection first"]);
  }
  const order = args.order ?? nextOrder(siblingOrders(args.parentDir));
  const file = requestPathFor(args.parentDir, args.name);
  writeFileAtomic(file, skeletonFor(args.kind, sanitiseSegment(args.name), order));
  return Promise.resolve(file);
}

/**
 * Write the definition that names and orders a group directory.
 *
 * Always `$kind: collection`, for folders too. That is what real workspaces contain,
 * and `workspace/collections.ts` derives folder-versus-collection from tree position
 * rather than this field — so writing anything else would be inventing a convention.
 */
function writeDefinition(dir: string, name: string, order: number): void {
  writeFileAtomic(definitionPathFor(dir), stringify({ $kind: COLLECTION_KIND, [NAME_KEY]: name, [ORDER_KEY]: order }));
}

export interface CreateGroupArgs {
  parentDir: string;
  name: string;
  order?: number;
}

/** Create a folder directory with a definition naming and ordering it. */
export function createFolder(args: CreateGroupArgs): Promise<string> {
  if (!existsSync(args.parentDir)) {
    throw usage(`${args.parentDir} does not exist`, ["create the parent collection or folder first"]);
  }
  const order = args.order ?? nextOrder(siblingOrders(args.parentDir));
  const dir = groupPathFor(args.parentDir, args.name);
  mkdirSync(dir, { recursive: true });
  writeDefinition(dir, sanitiseSegment(args.name), order);
  return Promise.resolve(dir);
}

export interface CreateCollectionArgs {
  /** The workspace root. Collections have exactly one home, so the caller need not know it. */
  root: string;
  name: string;
  order?: number;
}

/** Create a collection directory with a definition naming and ordering it. */
export function createCollection(args: CreateCollectionArgs): Promise<string> {
  const collectionsDir = collectionsDirFor(args.root);
  mkdirSync(collectionsDir, { recursive: true });
  const order = args.order ?? nextOrder(siblingOrders(collectionsDir));
  const dir = groupPathFor(collectionsDir, args.name);
  mkdirSync(dir, { recursive: true });
  writeDefinition(dir, sanitiseSegment(args.name), order);
  return Promise.resolve(dir);
}

export interface CreateEnvironmentArgs {
  /** The workspace root. Environments have exactly one home too. */
  root: string;
  name: string;
}

/**
 * Create an environment file holding a name and no values.
 *
 * No `order`: environments are picked by name, never run in sequence, so the
 * concept does not apply to them.
 */
export function createEnvironmentFile(args: CreateEnvironmentArgs): Promise<string> {
  const dir = environmentsDirFor(args.root);
  mkdirSync(dir, { recursive: true });
  const clean = sanitiseSegment(args.name);
  const file = environmentPathFor(dir, clean);
  writeFileAtomic(file, stringify({ [NAME_KEY]: clean, values: [] }));
  return Promise.resolve(file);
}

function isRequestFile(target: string): boolean {
  return target.endsWith(REQUEST_SUFFIX);
}

function isEnvironmentFile(target: string): boolean {
  return target.endsWith(ENVIRONMENT_SUFFIX);
}

/**
 * Rename a request, environment, folder or collection, returning the new path.
 *
 * The filename and the `name` field are set in one operation because they must
 * never drift: a selector resolves against `name`, and a human reads the filename.
 */
export function renameNode(args: { target: string; name: string }): Promise<string> {
  const { target, name } = args;
  if (!existsSync(target)) throw usage(`${target} does not exist`, ["it may have been deleted outside the app"]);
  const clean = sanitiseSegment(name);
  const parent = dirname(target);

  if (isRequestFile(target) || isEnvironmentFile(target)) {
    const request = isRequestFile(target);
    const suffix = request ? REQUEST_SUFFIX : ENVIRONMENT_SUFFIX;
    const next =
      basename(target) === `${clean}${suffix}`
        ? target
        : request
          ? requestPathFor(parent, clean)
          : environmentPathFor(parent, clean);
    const doc = readDocument(target);
    doc.setIn([NAME_KEY], clean);
    if (request) validateRequest(target, doc);
    else validateEnvironment(target, doc);
    // Write through the old path first: a failure then leaves one intact file, not two.
    writeFileAtomic(target, doc.toString());
    if (next !== target) renameSync(target, next);
    return Promise.resolve(next);
  }

  const next = basename(target) === clean ? target : groupPathFor(parent, clean);
  if (next !== target) renameSync(target, next);
  const definition = definitionPathFor(next);
  if (existsSync(definition)) {
    const doc = readDocument(definition);
    doc.setIn([NAME_KEY], clean);
    validateDefinition(definition, doc);
    writeFileAtomic(definition, doc.toString());
  } else {
    writeDefinition(next, clean, nextOrder(siblingOrders(parent)));
  }
  return Promise.resolve(next);
}

/** True when `child` is `parent` or lives underneath it. */
function isWithin(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`));
}

export interface MoveArgs {
  target: string;
  targetDir: string;
  order?: number;
}

/** Move a request or group into `targetDir`, refusing anything that would eat itself. */
export function moveNode(args: MoveArgs): Promise<string> {
  const { target, targetDir } = args;
  if (!existsSync(target)) throw usage(`${target} does not exist`, ["it may have been deleted outside the app"]);
  if (!existsSync(targetDir)) throw usage(`${targetDir} does not exist`, ["create the destination first"]);

  const isRequest = isRequestFile(target);
  if (!isRequest && isWithin(target, targetDir)) {
    throw usage(`cannot move ${basename(target)} into itself`, [
      `${targetDir} is ${resolve(target) === resolve(targetDir) ? "the same directory" : "inside the moved directory"}`,
    ]);
  }

  const order = args.order ?? nextOrder(siblingOrders(targetDir));
  const name = isRequest ? basename(target).slice(0, -REQUEST_SUFFIX.length) : basename(target);
  const next = isRequest ? requestPathFor(targetDir, name) : groupPathFor(targetDir, name);
  if (resolve(next) === resolve(target)) return Promise.resolve(target);

  renameSync(target, next);
  const file = isRequest ? next : definitionPathFor(next);
  if (!existsSync(file)) {
    writeDefinition(next, name, order);
    return Promise.resolve(next);
  }
  const doc = readDocument(file);
  doc.setIn([ORDER_KEY], order);
  if (isRequest) validateRequest(file, doc);
  else validateDefinition(file, doc);
  writeFileAtomic(file, doc.toString());
  return Promise.resolve(next);
}

/**
 * Delete a request file, or a group directory and everything under it.
 *
 * Core does not confirm. A GUI has a dialog and the CLI has a prompt; a library
 * that asks questions cannot be called from either.
 */
export function deleteNode(target: string): Promise<void> {
  if (!existsSync(target)) throw usage(`${target} does not exist`, ["it may have been deleted already"]);
  if (isRequestFile(target) || isEnvironmentFile(target)) unlinkSync(target);
  else rmSync(target, { recursive: true, force: true });
  return Promise.resolve();
}

/**
 * Rewrite the `order` of named siblings in one pass.
 *
 * Keyed by absolute path rather than by name because two siblings can share a
 * display name after a rename collision, and only the path is unambiguous.
 */
export function reorderSiblings(args: { orderByFile: Record<string, number> }): Promise<void> {
  for (const [target, order] of Object.entries(args.orderByFile)) {
    const file = isRequestFile(target) ? target : definitionPathFor(target);
    if (!existsSync(file)) {
      if (isRequestFile(target)) throw usage(`${target} does not exist`, ["reorder was abandoned part-way"]);
      writeDefinition(target, basename(target), order);
      continue;
    }
    const doc = readDocument(file);
    doc.setIn([ORDER_KEY], order);
    if (isRequestFile(target)) validateRequest(file, doc);
    else validateDefinition(file, doc);
    writeFileAtomic(file, doc.toString());
  }
  return Promise.resolve();
}
