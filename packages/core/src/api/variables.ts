import { PremanError } from "@preman/core/errors.js";
import { SCOPES, VariableStore, type Scope } from "@preman/core/vars/store.js";
import { requireWorkspace, type Workspace } from "@preman/core/workspace/discover.js";
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
  /** The environment's name, or {@link GLOBALS_LABEL}. */
  label: string;
  /** Where the values live, whether or not the file exists yet. */
  file: string;
  /** Whether writing here is supported. Only environment files are writable. */
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

/**
 * The scope chain behind a `{{token}}`, for a reader rather than a run.
 *
 * `null` and `undefined` both mean "no environment": an inspection has no ambiguity to
 * resolve, so unlike a run it never adopts a sole environment and never asks.
 *
 * Only the scopes a workspace can persist are reported. `data` and `local` exist solely
 * for the duration of a run, and `collection` is declared by {@link SCOPES} but no
 * workspace file populates it.
 */
export function readVariables(dir: string, name: string | null | undefined): VariableView {
  const ws = requireWorkspace(dir);
  const env = name == null ? undefined : requireEnvironment(ws, name);
  const globals = loadGlobals(ws);

  const store = new VariableStore({
    globals,
    ...(env === undefined ? {} : { environment: env.values }),
  });

  const layers: VariableLayer[] = [
    { scope: "globals", label: GLOBALS_LABEL, file: globalsFile(ws), writable: false, values: globals },
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
