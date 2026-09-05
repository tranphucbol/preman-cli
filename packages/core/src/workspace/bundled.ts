import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The vendored tree's name, shared by the source checkout and every build that copies it. */
const VENDOR_DIR = "vendor";
const GOOGLE_PROTOS_DIR = "google-protos";

/**
 * Where the tree sits relative to *this module*, in each context that runs it.
 *
 * Source (`src/workspace/bundled.ts`) climbs to the package root. Both bundles are one flat
 * file with `vendor/` emitted beside them, so the tree is a sibling. Order is irrelevant —
 * only one candidate can exist in a given layout — but source is first because that is the
 * one a test run asks for.
 */
const CANDIDATE_PATHS = [
  ["..", "..", VENDOR_DIR, GOOGLE_PROTOS_DIR],
  [VENDOR_DIR, GOOGLE_PROTOS_DIR],
];

/**
 * `undefined` is a real answer — a build that forgot to copy the tree — so absence is
 * distinguished from "not looked yet" by the box rather than by the value.
 */
let resolved: { root: string | undefined } | undefined;

/**
 * The vendored `google/**` import root, or `undefined` if this build did not ship one.
 *
 * A service's `.proto` that says `import "google/api/annotations.proto"` can only resolve it
 * from an include dir, and preman's include dirs are the spec's own ancestors bounded by the
 * workspace, the checkout or the shared link (ADRs 038 and 042). No ancestor of a service's
 * proto is ever a `google/` root, so without this the import resolves relative to the importer
 * and fails as `.../api/zas/google/api/annotations.proto`. Maven writes a copy into
 * `target/protoc-dependencies/<hash>/`, but that is gitignored, hash-named and absent from a
 * fresh clone, so it cannot be the answer.
 *
 * This is deliberately not in `Resources.includeDirs`: that list describes the
 * *workspace*, and is printed. This root belongs to preman and is the same everywhere, so
 * naming it in a workspace listing would be noise on every row.
 *
 * `google/protobuf/*` is not here and must not be added — protobufjs answers those from its
 * own bundled map before an include dir is consulted (ADR 045).
 */
export function bundledProtoRoot(): string | undefined {
  if (resolved !== undefined) return resolved.root;
  const here = dirname(fileURLToPath(import.meta.url));
  const root = CANDIDATE_PATHS.map((parts) => resolve(here, ...parts)).find((path) => existsSync(path));
  resolved = { root };
  return root;
}

/**
 * `dirs` with the bundled root appended, if there is one.
 *
 * Appended, never prepended: a repository that vendors its own `google/api/annotations.proto`
 * has to keep winning, because the version it compiles against is the one its generated code
 * expects. Last place also makes this inert for the workspaces that already load — it is only
 * ever reached after every real include dir has failed.
 */
export function withBundledProtoRoot(dirs: readonly string[]): string[] {
  const root = bundledProtoRoot();
  return root === undefined ? [...dirs] : [...dirs, root];
}
