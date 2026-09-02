/**
 * Declaring `.proto` specs, and the shared links that make those declarations portable.
 *
 * `.postman/resources.yaml` is the workspace's proto index, and until now the only way
 * to add to it was to edit it by hand. That is the gap this module closes — but adding
 * a path is the easy half. The hard half is that a path to another checkout is a path
 * to *this machine's* checkout, so a committed workspace full of them only works for
 * whoever wrote it.
 *
 * So every spec is declared through {@link DEFAULT_SHARED_PROTO_ROOT}: the checkout is
 * linked once under a name, and the workspace refers to it by that name. The paths
 * become machine-independent, and the setup a second machine needs collapses from one
 * fix per spec to one link per repository — which {@link describeSpecs} reports as
 * `unresolvedLinks` so a front end can offer exactly that.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import * as protoLoader from "@grpc/proto-loader";
import { parseDocument, type Document } from "yaml";
import { PremanError } from "@preman/core/errors.js";
import { LOAD_OPTIONS } from "@preman/core/grpc/schema.js";
import { writeFileAtomic } from "@preman/core/workspace/atomic.js";
import { requireWorkspace, type Workspace } from "@preman/core/workspace/discover.js";
import {
  declaredSharedPath,
  linkNameForRepo,
  linkNameFor,
  listSharedLinks,
  readSharedLink,
  repoRootFor,
  resolveSharedPath,
  sharedProtoRoot,
  writeSharedLink,
  type SharedLink,
} from "@preman/core/workspace/links.js";
import {
  deriveIncludeDirs,
  loadResources,
  PROTO_EXTENSION,
  resolveDeclaredSpec,
  type SpecVia,
} from "@preman/core/workspace/resources.js";

/** Path separator used inside resources.yaml, which is a committed file and so is posix. */
const LOCATION_SEPARATOR = "/";

/** Where the specs list lives in `resources.yaml`. */
const SPECS_PATH = ["localResources", "specs"] as const;

/** Directories a folder walk never descends into; none of them hold protos worth declaring. */
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "vendor", "target", "dist", "build"]);

export interface DeclaredSpec {
  /** Exactly as written in `resources.yaml`. */
  declared: string;
  /** Where that resolves on this machine. */
  path: string;
  exists: boolean;
  /** The shared link it is reached through, when it is on one. */
  link: string | undefined;
  /**
   * Which root answered: the link, the checkout the workspace itself is in, or both.
   *
   * Reported rather than hidden behind `exists`. A spec that resolved through the checkout alone
   * has nothing wrong with it, but the link it names is still worth creating for a workspace that
   * is not inside this repository — and a silently green row is how that never happens. `both` is
   * the machine where the link was made: it points at this same checkout, so which root answered
   * is a distinction with no difference and the front ends say nothing (ADR 042).
   */
  via: SpecVia;
}

export interface SpecsView {
  root: string;
  /** Where the declarations live, even when the file has yet to be created. */
  resourcesPath: string;
  sharedRoot: string;
  specs: DeclaredSpec[];
  /** Everything currently linked here, whether this workspace uses it or not. */
  links: SharedLink[];
  /**
   * Link names this workspace's specs need that are missing or dangling on this
   * machine. Fixing one of these fixes every spec underneath it at once.
   *
   * A name whose specs all resolved out of the workspace's own checkout is not in here: there is
   * nothing for the reader to repair. The name is still carried by the spec rows, because a
   * workspace elsewhere on this machine may need the link that this one does not.
   */
  unresolvedLinks: string[];
  /**
   * The checkout the workspace itself is in, when it is in one.
   *
   * Computed here rather than in each front end: both need it for the same two things — the link
   * name it would take, and the path to pre-fill instead of asking someone to find a directory
   * the engine is already standing in (ADR 042).
   */
  ownCheckout: string | undefined;
}

/**
 * What applying a plan would do to one link.
 *
 * `conflict` is never resolved silently. The name is already pointing somewhere, and
 * that target is load-bearing for any workspace that declared a path through it —
 * including workspaces that are not open, whose breakage would surface far from here.
 */
export type LinkAction = "reuse" | "create" | "repoint" | "conflict";

export interface PlannedLink {
  name: string;
  target: string;
  action: LinkAction;
  /** Where the name points today. Set only when `action` is `conflict` or `repoint`. */
  existingTarget?: string;
}

export interface PlannedSpec {
  /** The file as it can be reached today. */
  source: string;
  /** What would be written into `resources.yaml`, or {@link source} when nothing would be. */
  declared: string;
  /**
   * The link name {@link declared} goes through, or `undefined` when the file is not there.
   *
   * A link is named after the repository the proto was found in, and a path that does not
   * resolve has no repository to be found in: the climb for `.git` fails and the fallback is
   * the file's own directory, which turns `.../proto/user/user-profile.proto` into a link
   * called `user`. That is a guess wearing a repository's clothes, and two of them collide
   * the moment a second checkout has a `zas` or an `admin` directory. So a missing source is
   * planned as an entry with no link, reported by {@link loadError}, and skipped on apply —
   * it stays declared exactly as it was.
   */
  link: string | undefined;
  /** An existing declaration this would replace, when converting rather than adding. */
  replaces?: string;
  /** Already declared exactly this way; applying would change nothing. */
  duplicate: boolean;
  /**
   * Why the proto would not load with the include dirs it is about to get. Reported
   * before the write rather than as a missing method in a picker later.
   */
  loadError?: string;
}

export interface SpecPlan {
  sharedRoot: string;
  /** Deduped, in the order the entries first needed them. */
  links: PlannedLink[];
  entries: PlannedSpec[];
  /** Link names in conflict. Non-empty means {@link applySpecPlan} will refuse. */
  conflicts: string[];
}

/** Per-link answers to the questions a plan cannot decide on its own. */
export interface LinkOverride {
  /** Link this checkout under another name instead, leaving the existing link alone. */
  name?: string;
  /** Move the existing link to this checkout. Breaks anything declared through it. */
  repoint?: boolean;
}

export interface PlanOptions {
  /** Keyed by the name the plan derived, so a front end can answer a conflict it was shown. */
  overrides?: Record<string, LinkOverride>;
}

function resourcesPathFor(ws: Workspace): string {
  return ws.resourcesPath ?? join(ws.root, ".postman", "resources.yaml");
}

/** The parsed `resources.yaml`, or an empty document when the workspace has yet to declare one. */
function readResources(resourcesPath: string): Document.Parsed {
  if (!existsSync(resourcesPath)) return parseDocument("");
  let source: string;
  try {
    source = readFileSync(resourcesPath, "utf8");
  } catch (cause) {
    throw new PremanError(`failed to read ${resourcesPath}: ${(cause as Error).message}`);
  }
  const doc = parseDocument(source);
  if (doc.errors.length > 0) {
    throw new PremanError(`failed to parse ${resourcesPath}: ${doc.errors[0]?.message ?? "invalid YAML"}`);
  }
  return doc;
}

/** The specs list verbatim, with nothing resolved and nothing dropped. */
function specsIn(doc: Document.Parsed): string[] {
  const tree = doc.toJS() as { localResources?: { specs?: unknown } } | null;
  const raw = tree?.localResources?.specs;
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string");
}

function declaredSpecs(resourcesPath: string): string[] {
  return specsIn(readResources(resourcesPath));
}

export function describeSpecs(dir: string): SpecsView {
  const ws = requireWorkspace(dir);
  const sharedRoot = sharedProtoRoot();
  const resourcesPath = resourcesPathFor(ws);
  const base = dirname(resourcesPath);

  const ownCheckout = repoRootFor(ws.root);

  const specs = declaredSpecs(resourcesPath).map((declared): DeclaredSpec => {
    const declaredPath = resolve(base, declared);
    const { path, via } = resolveDeclaredSpec(declaredPath, sharedRoot, ownCheckout);
    // The link name is the one the *declaration* names, whichever root answered it: that is what
    // `preman protos link` takes, and it does not stop being the answer for a second workspace.
    const link = linkNameFor(resolveSharedPath(declaredPath, sharedRoot), sharedRoot);
    return { declared, path, exists: existsSync(path), link, via };
  });

  const unresolved = new Set<string>();
  for (const spec of specs) {
    if (spec.link === undefined || spec.exists) continue;
    const link = readSharedLink(sharedRoot, spec.link);
    if (link === undefined || !link.resolves) unresolved.add(spec.link);
  }

  return {
    root: ws.root,
    resourcesPath,
    sharedRoot,
    specs,
    links: listSharedLinks(sharedRoot),
    unresolvedLinks: [...unresolved].sort(),
    ownCheckout,
  };
}

/** Every `.proto` under `dir`, sorted, skipping the directories no one declares out of. */
export function collectProtoFiles(dir: string): string[] {
  const root = resolve(dir);
  const found: string[] = [];

  const walk = (current: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      // An unreadable directory is not worth failing a folder pick over.
      return;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) walk(path);
      } else if (entry.isFile() && extname(entry.name) === PROTO_EXTENSION) {
        found.push(path);
      }
    }
  };

  walk(root);
  return found.sort();
}

/**
 * The link a file would be declared through, before overrides.
 *
 * Falls back to the file's own directory when nothing above it looks like a checkout,
 * so a proto picked out of a downloads folder still gets a link rather than a path
 * only this machine can read.
 */
function deriveLink(file: string): { name: string; target: string } {
  const target = repoRootFor(file) ?? dirname(resolve(file));
  return { name: linkNameForRepo(target), target };
}

function planLink(
  sharedRoot: string,
  derived: { name: string; target: string },
  override: LinkOverride | undefined,
): PlannedLink {
  const name = override?.name ?? derived.name;
  const existing = readSharedLink(sharedRoot, name);
  if (existing === undefined) return { name, target: derived.target, action: "create" };
  if (existing.target === derived.target) return { name, target: derived.target, action: "reuse" };
  const existingTarget = existing.target ?? join(sharedRoot, name);
  if (override?.repoint === true) {
    return { name, target: derived.target, action: "repoint", existingTarget };
  }
  return { name, target: derived.target, action: "conflict", existingTarget };
}

function loadErrorFor(
  source: string,
  repoRoot: string,
  sharedRoot: string,
  extra: readonly string[],
): string | undefined {
  // The link points at the checkout, so the include dirs a spec gets through it are the
  // same ones it gets inside it — which is what lets this check run before any link exists.
  // Own tree first, then the workspace, matching `Resources.includeDirsFor`: check it the
  // way it will be loaded, or this answers a question nobody asked.
  const includeDirs = [...new Set([...deriveIncludeDirs([source], repoRoot, sharedRoot), ...extra])];
  try {
    protoLoader.loadSync(source, { ...LOAD_OPTIONS, includeDirs });
    return undefined;
  } catch (cause) {
    return (cause as Error).message;
  }
}

function planFor(
  ws: Workspace,
  files: readonly string[],
  replacing: ReadonlyMap<string, string>,
  options: PlanOptions,
): SpecPlan {
  const sharedRoot = sharedProtoRoot();
  const resourcesPath = resourcesPathFor(ws);
  const already = new Set(declaredSpecs(resourcesPath));
  const existing = loadResources(ws).includeDirs;
  const overrides = options.overrides ?? {};

  const links = new Map<string, PlannedLink>();
  const entries: PlannedSpec[] = [];

  for (const file of files) {
    const source = resolve(file);

    // No file, no repository to name a link after — see `PlannedSpec.link`. Reported and left
    // alone rather than skipped silently: on the workspace that drove this feature, thirteen of
    // thirty-two specs point at a colleague's home directory, and "these thirteen are not on
    // this machine" is the answer their owner needs.
    if (!existsSync(source)) {
      entries.push({
        source,
        declared: source,
        link: undefined,
        duplicate: false,
        loadError: `${source} does not exist`,
      });
      continue;
    }

    const derived = deriveLink(source);
    const link = links.get(derived.name) ?? planLink(sharedRoot, derived, overrides[derived.name]);
    links.set(derived.name, link);

    const rest = relative(link.target, source).split(sep).join(LOCATION_SEPARATOR);
    const declared = declaredSharedPath(link.name, rest);
    const replaces = replacing.get(source);

    entries.push({
      source,
      declared,
      link: link.name,
      ...(replaces === undefined ? {} : { replaces }),
      duplicate: already.has(declared) && replaces === undefined,
      ...maybeLoadError(source, link.target, sharedRoot, existing),
    });
  }

  const planned = [...links.values()];
  return {
    sharedRoot,
    links: planned,
    entries,
    conflicts: planned.filter((l) => l.action === "conflict").map((l) => l.name),
  };
}

function maybeLoadError(
  source: string,
  repoRoot: string,
  sharedRoot: string,
  extra: readonly string[],
): { loadError?: string } {
  // A missing source never reaches here: `planFor` answers that case above, because it decides
  // there is no link rather than only that there is no load.
  const error = loadErrorFor(source, repoRoot, sharedRoot, extra);
  return error === undefined ? {} : { loadError: error };
}

/** Stages declaring `files`, without writing anything. */
export function planSpecs(dir: string, files: readonly string[], options: PlanOptions = {}): SpecPlan {
  return planFor(requireWorkspace(dir), files, new Map(), options);
}

/**
 * Stages moving every already-declared spec that is not on a link onto one.
 *
 * This is what makes the shared root worth choosing: a workspace whose specs are half
 * relative and half absolute is portable for nobody, and rewriting those paths by hand
 * is exactly the work the feature exists to remove.
 */
export function planSpecConversion(dir: string, options: PlanOptions = {}): SpecPlan {
  const ws = requireWorkspace(dir);
  const view = describeSpecs(dir);
  const stale = view.specs.filter((spec) => spec.link === undefined);
  const replacing = new Map(stale.map((spec) => [spec.path, spec.declared]));
  return planFor(
    ws,
    stale.map((spec) => spec.path),
    replacing,
    options,
  );
}

/**
 * Creates the plan's links and writes its declarations.
 *
 * Goes through `parseDocument` rather than `parse` + `stringify` so comments and any
 * key this engine does not read — `resourceNameMappings`, which Postman writes and
 * preman ignores — survive the edit.
 */
export function applySpecPlan(dir: string, plan: SpecPlan): SpecsView {
  const ws = requireWorkspace(dir);

  if (plan.conflicts.length > 0) {
    throw new PremanError("cannot apply: some links are in conflict", {
      details: [
        ...plan.links
          .filter((l) => l.action === "conflict")
          .map((l) => `  ${l.name} points at ${l.existingTarget ?? "?"}, wanted ${l.target}`),
        "repoint each one, or give it another name",
      ],
    });
  }

  for (const link of plan.links) {
    writeSharedLink(plan.sharedRoot, link.name, link.target, { repoint: link.action === "repoint" });
  }

  const resourcesPath = resourcesPathFor(ws);
  const replaced = new Map<string, string>();
  const added: string[] = [];
  for (const entry of plan.entries) {
    // A linkless entry is a spec whose file is not on this machine. It has nothing to be
    // written through, so it keeps the declaration it already has.
    if (entry.link === undefined) continue;
    if (entry.replaces !== undefined) replaced.set(entry.replaces, entry.declared);
    else if (!entry.duplicate) added.push(entry.declared);
  }

  writeSpecs(resourcesPath, (current) => {
    const next = current.map((declared) => replaced.get(declared) ?? declared);
    const seen = new Set(next);
    for (const declared of added) {
      if (seen.has(declared)) continue;
      seen.add(declared);
      next.push(declared);
    }
    return next;
  });

  return describeSpecs(ws.root);
}

/** Undeclares a spec. Never removes the link: other workspaces may still declare through it. */
export function removeSpec(dir: string, declared: string): SpecsView {
  const ws = requireWorkspace(dir);
  const resourcesPath = resourcesPathFor(ws);
  const current = declaredSpecs(resourcesPath);
  if (!current.includes(declared)) {
    throw new PremanError(`${declared} is not declared in ${resourcesPath}`);
  }
  writeSpecs(resourcesPath, (specs) => specs.filter((entry) => entry !== declared));
  return describeSpecs(ws.root);
}

/** Links a checkout by hand — the repair a machine without the links needs. */
export function linkCheckout(name: string, target: string, options: { repoint?: boolean } = {}): SharedLink {
  return writeSharedLink(sharedProtoRoot(), name, target, options);
}

function writeSpecs(resourcesPath: string, update: (current: string[]) => string[]): void {
  const doc = readResources(resourcesPath);
  // `setIn` stores whatever it is handed, and a raw JS array lands as a node the next
  // edit cannot walk; `createNode` is what makes the write survive a second one.
  doc.setIn([...SPECS_PATH], doc.createNode(update(specsIn(doc))));
  writeFileAtomic(resourcesPath, doc.toString());
}

/** Whether a path is a `.proto`, for a front end filtering a drop or a pick. */
export function isProtoFile(path: string): boolean {
  return extname(path) === PROTO_EXTENSION && statSyncSafe(path);
}

function statSyncSafe(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
