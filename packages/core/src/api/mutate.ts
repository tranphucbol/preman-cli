import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parseDocument, stringify, type Document } from "yaml";
import type { ZodTypeAny } from "zod";
import { EXIT, PremanError } from "@preman/core/errors.js";
import { writeFileAtomic } from "@preman/core/workspace/atomic.js";
import { existingEnvironmentName } from "@preman/core/workspace/environments.js";
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

/**
 * Apply edits in order, each value wrapped as a node first.
 *
 * `setIn` stores whatever it is handed, so a plain JS array or object lands in the tree
 * unwrapped. That serialises correctly, which is why passing raw values looked fine, but it
 * is invisible to the next edit: `setIn` walks with `isCollection`, a raw array fails that
 * test while not being `undefined` either, and `yaml` throws
 * `Expected YAML collection at <key>` instead of descending. A batch can always reach into
 * what an earlier edit in the same batch created - the pair grid writes the whole list when a
 * row appears, then addresses `[field, index, "value"]` when the next cell is typed - so the
 * wrap is not optional.
 */
function applyEdits(doc: Document, edits: readonly FieldEdit[]): void {
  for (const edit of edits) {
    if (edit.path.length === 0) throw usage("an edit must name a field", ["the empty path addresses the document"]);
    if (edit.value === undefined) doc.deleteIn(edit.path);
    else doc.setIn(edit.path, doc.createNode(edit.value));
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

/** The word appended to the source's display name to make the copy's. */
const COPY_SUFFIX = "copy";
/** The first numbered copy is 2: `Foo copy`, `Foo copy 2`. There is no `Foo copy 1`. */
const FIRST_NUMBERED_COPY = 2;
/** The same bound `resolveCollision` uses, for the same reason: a loop that cannot run away. */
const COPY_LIMIT = 100;

/**
 * The first free `Foo copy`, `Foo copy 2`, … in `dir`.
 *
 * Deliberately not `resolveCollision`: that function's contract is a *path* with
 * Postman's ` (2)` convention, and it lets the filename diverge from the display
 * name on purpose. A copy generates its own name, so the two must agree — see
 * `duplicateRequestFile`.
 */
function freeCopyName(dir: string, base: string): string {
  let name = `${base} ${COPY_SUFFIX}`;
  for (let n = FIRST_NUMBERED_COPY; existsSync(join(dir, `${name}${REQUEST_SUFFIX}`)); n += 1) {
    if (n > COPY_LIMIT) {
      throw usage(`cannot find a free name for a copy of "${base}" in ${dir}`, [
        `tried up to "${base} ${COPY_SUFFIX} ${COPY_LIMIT}"`,
      ]);
    }
    name = `${base} ${COPY_SUFFIX} ${n}`;
  }
  return name;
}

/** The display name a request file declares, falling back to what its filename says. */
function displayNameOf(file: string, doc: Document): string {
  const declared = (doc.toJS() as { name?: unknown } | null)?.name;
  if (typeof declared === "string" && declared.trim().length > 0) return declared;
  return basename(file).slice(0, -REQUEST_SUFFIX.length);
}

export interface DuplicateRequestArgs {
  /** The request file to copy. A group is refused. */
  target: string;
  /** Omitted means "last", derived from the highest declared sibling order. */
  order?: number;
}

/**
 * Copy a request file into its own folder as `Foo copy`, returning the new path.
 *
 * The copy's display name and its filename are both `Foo copy`, which is the
 * opposite of `createRequestFile`, where `requestPathFor` resolves `Foo` to
 * `Foo (2).request.yaml` while the file keeps saying `Foo`. That divergence is
 * right for a name a human typed twice and wrong here: this name is generated, so
 * two nodes both reading `Foo copy` would be indistinguishable in the tab strip
 * and ambiguous to a CLI selector. Do not unify the two.
 *
 * Goes through `parseDocument` rather than `parse` + `stringify` because the
 * comments, `pm` scripts and examples in the source are the reason to duplicate it
 * at all. A source that no longer validates therefore cannot be duplicated, which
 * is correct: the copy would be a second unreadable file.
 */
export function duplicateRequestFile(args: DuplicateRequestArgs): Promise<string> {
  const { target } = args;
  if (!existsSync(target)) throw usage(`${target} does not exist`, ["it may have been deleted outside the app"]);
  if (!isRequestFile(target)) {
    throw usage(`${basename(target)} is not a request`, [
      "duplicating a collection or folder is not supported",
      "copy the requests inside it one at a time",
    ]);
  }

  const dir = dirname(target);
  const doc = readDocument(target);
  // The name resolves before the path, from the same string, so they cannot drift.
  const name = freeCopyName(dir, sanitiseSegment(displayNameOf(target, doc)));
  const file = join(dir, `${name}${REQUEST_SUFFIX}`);
  doc.setIn([NAME_KEY], name);
  doc.setIn([ORDER_KEY], args.order ?? nextOrder(siblingOrders(dir)));
  validateRequest(target, doc);
  writeFileAtomic(file, doc.toString());
  return Promise.resolve(file);
}

export interface WriteRequestArgs {
  parentDir: string;
  /** The display name; the filename is derived from it, collisions resolved. */
  name: string;
  /** A whole request document, without `order`. */
  contents: string;
  kind: RequestKind;
  /** Omitted means "last", derived from the highest declared sibling order. */
  order?: number;
}

/**
 * Write a whole request document, returning the path actually used.
 *
 * Beside {@link createRequestFile} rather than through it (decision 8): the skeleton writer
 * exists for an empty request that a person will fill in, and an import arrives with a whole
 * document already. Creating the skeleton and then replaying a batch of {@link FieldEdit}s
 * would put a half-populated file in front of the watcher between the two.
 *
 * `order` is appended here rather than carried in `contents` because the destination decides
 * it and the plan that produced `contents` has no destination — which is also why an import
 * preview is the document minus one trailing line.
 */
export function writeRequestFile(args: WriteRequestArgs): string {
  if (!existsSync(args.parentDir)) {
    throw usage(`${args.parentDir} does not exist`, ["create the folder or collection first"]);
  }
  const doc = parseDocument(args.contents);
  if (doc.errors.length > 0) {
    throw usage(
      "the imported request is not valid YAML",
      doc.errors.map((error) => error.message),
    );
  }
  doc.setIn([ORDER_KEY], args.order ?? nextOrder(siblingOrders(args.parentDir)));

  const file = requestPathFor(args.parentDir, args.name);
  validateAgainst(file, doc, args.kind === GRPC_KIND ? grpcRequestSchema : httpRequestSchema);
  writeFileAtomic(file, doc.toString());
  return file;
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
 *
 * A name already in use is refused rather than resolved to a free one, which is the
 * opposite of `createRequestFile` and needs saying why. There, `requestPathFor` writes
 * `Foo (2).request.yaml` while the file keeps saying `Foo`, and that divergence is
 * harmless because a request is addressed by its path. An environment is addressed by
 * its name and by nothing else — `findEnvironment`, the `-e` flag and the picker all
 * resolve one — so the same divergence would put two files behind one name, and every
 * read and every `writeEnvironmentValue` would reach the first of them while the second
 * quietly rotted. Renaming the user's input instead would be a second surprise, so the
 * answer is a refusal the caller can show beside the field that caused it.
 */
export function createEnvironmentFile(args: CreateEnvironmentArgs): Promise<string> {
  const dir = environmentsDirFor(args.root);
  const clean = sanitiseSegment(args.name);
  const taken = existingEnvironmentName(dir, clean);
  if (taken !== undefined) {
    throw usage(`an environment named "${taken}" already exists`, ["pick a name no other environment uses"]);
  }
  mkdirSync(dir, { recursive: true });
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
