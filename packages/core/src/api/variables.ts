import { PremanError } from "@preman/core/errors.js";
import { SCOPES, VariableStore, type Scope } from "@preman/core/vars/store.js";
import { setDefinitionVariable } from "@preman/core/api/mutate.js";
import { readGroupDefinition } from "@preman/core/workspace/definitions.js";
import { requireWorkspace, type Workspace } from "@preman/core/workspace/discover.js";
import { collectionDirOf, definitionPathFor } from "@preman/core/workspace/paths.js";
import {
  findEnvironment,
  globalsFile,
  listEnvironments,
  loadGlobals,
  type EnvironmentEntry,
} from "@preman/core/workspace/environments.js";

/**
 * The layer heading for workspace globals. Environments are labelled by their own name,
 * so this is the only scope that needs one written down.
 */
const GLOBALS_LABEL = "globals";

export interface VariableLayer {
  scope: Scope;
  /** The environment's or collection's name, or {@link GLOBALS_LABEL}. */
  label: string;
  /** Where the values live, whether or not the file exists yet. */
  file: string;
  /** Whether writing here is supported. Environments and collections are; globals are not. */
  writable: boolean;
  values: Record<string, string>;
}

export interface VariableBinding {
  key: string;
  /** The value a `{{key}}` token resolves to, as {@link VariableStore} resolves it. */
  value: string;
  /** The layer that wins. */
  scope: Scope;
  /** Layers that also carry `key` and lose, lowest precedence first. */
  shadowed: readonly Scope[];
}

export interface VariableView {
  /** The environment in play, or `undefined` when none is. */
  environment: string | undefined;
  /** Every layer that exists, lowest precedence first. */
  layers: readonly VariableLayer[];
  /** One row per key, sorted, with the winner already resolved. */
  bindings: readonly VariableBinding[];
}

function requireEnvironment(ws: Workspace, name: string): EnvironmentEntry {
  const found = findEnvironment(ws, name);
  if (found) return found;

  const all = listEnvironments(ws);
  throw new PremanError(`environment "${name}" not found`, {
    details: all.length > 0 ? ["available:", ...all.map((e) => `  ${e.name}`)] : ["no environments exist"],
  });
}

/**
 * Which layers hold `key`, lowest precedence first. Derived from {@link SCOPES}, the
 * same ordering {@link VariableStore.get} walks, so precedence is never restated here.
 */
function holders(store: VariableStore, key: string): Scope[] {
  return SCOPES.filter((scope) => store.getIn(scope, key) !== undefined);
}

/** The collection a reader is looking from: the one holding the request or group in view. */
export interface ReaderCollection {
  name: string;
  /** The collection's `.resources/definition.yaml`, whether or not it exists yet. */
  file: string;
  values: Record<string, string>;
}

export interface ReaderScope {
  ws: Workspace;
  /** The chosen environment, or `undefined` when none is. */
  env: EnvironmentEntry | undefined;
  /** The collection holding `at`, or `undefined` when `at` is not inside one. */
  collection: ReaderCollection | undefined;
  globals: Record<string, string>;
  /** The persistable layers, in the precedence {@link VariableStore} walks. */
  store: VariableStore;
}

function readerCollection(ws: Workspace, at: string | null | undefined): ReaderCollection | undefined {
  if (at == null) return undefined;
  const dir = collectionDirOf(ws.root, at);
  if (dir === undefined) return undefined;
  const definition = readGroupDefinition(dir, undefined, "collection");
  return { name: definition.name, file: definitionPathFor(dir), values: definition.variables };
}

/**
 * The layers a reader resolves against, for anything that answers a question about the
 * workspace rather than running against it: globals, the variables of the collection holding
 * `at` when there is one, and the chosen environment when there is one.
 *
 * `null` and `undefined` both mean "no environment": an inspection has no ambiguity to
 * resolve, so unlike a run it never adopts a sole environment and never asks. `at` is a
 * request, folder or collection path, absolute or relative to the workspace root; the same
 * token resolves differently in two collections, so a reader must say where it is looking.
 *
 * Only the scopes a workspace can persist are here: `data` and `local` exist solely for the
 * duration of a run. Shared with `previewText` so a listing and a preview can never describe
 * different chains.
 */
export function readerScope(dir: string, name: string | null | undefined, at?: string | null): ReaderScope {
  const ws = requireWorkspace(dir);
  const env = name == null ? undefined : requireEnvironment(ws, name);
  const collection = readerCollection(ws, at);
  const globals = loadGlobals(ws);

  const store = new VariableStore({
    globals,
    ...(collection === undefined ? {} : { collection: collection.values }),
    ...(env === undefined ? {} : { environment: env.values }),
  });

  return { ws, env, collection, globals, store };
}

/**
 * The scope chain behind a `{{token}}`, for a reader rather than a run. See
 * {@link readerScope} for which layers are in play and why.
 */
export function readVariables(dir: string, name: string | null | undefined, at?: string | null): VariableView {
  const { ws, env, collection, globals, store } = readerScope(dir, name, at);

  const layers: VariableLayer[] = [
    { scope: "globals", label: GLOBALS_LABEL, file: globalsFile(ws), writable: false, values: globals },
    ...(collection === undefined
      ? []
      : [
          {
            scope: "collection" as const,
            label: collection.name,
            file: collection.file,
            writable: true,
            values: collection.values,
          },
        ]),
    ...(env === undefined
      ? []
      : [
          {
            scope: "environment" as const,
            label: env.name,
            file: env.filePath,
            writable: true,
            values: env.values,
          },
        ]),
  ];

  const keys = [...new Set(layers.flatMap((layer) => Object.keys(layer.values)))].sort((a, b) => a.localeCompare(b));
  const bindings = keys.map((key) => {
    const chain = holders(store, key);
    const winner = chain[chain.length - 1]!;
    return { key, value: store.get(key) ?? "", scope: winner, shadowed: chain.slice(0, -1) };
  });

  return { environment: env?.name, layers, bindings };
}

export interface CollectionVariableWrite {
  /** The collection's name. */
  collection: string;
  /** The definition file written. */
  file: string;
  key: string;
  value: string;
}

/**
 * Set a variable on the collection holding `at`, in its `.resources/definition.yaml`.
 *
 * The only way a collection variable is persisted: a script's `pm.collectionVariables.set`
 * lasts for its run and is never written back, because a definition file is shared and
 * committed, and a run that rewrote it would leave a diff behind every time it was sent.
 */
export function writeCollectionVariable(dir: string, at: string, key: string, value: string): CollectionVariableWrite {
  const ws = requireWorkspace(dir);
  const collection = readerCollection(ws, at);
  if (collection === undefined) {
    throw new PremanError(`"${at}" is not inside a collection`, {
      details: ["collection variables belong to a collection under postman/collections"],
    });
  }
  setDefinitionVariable(collection.file, key, value);
  return { collection: collection.name, file: collection.file, key, value };
}
