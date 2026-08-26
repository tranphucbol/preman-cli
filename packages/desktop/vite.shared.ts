/**
 * What the four desktop entries agree on. Four `vite build` invocations rather than one
 * because main, preload, engine and renderer are four different runtimes, and pretending
 * otherwise is how a `node:fs` import ends up in a browser bundle.
 */
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { FAKER_MODULE, SANDBOX_ALIASES, SANDBOX_PACKAGES } from "../core/src/scripts/module-names.js";

export const BUILD_TARGET = "node20";
export const PACKAGE_ROOT = import.meta.dirname;
export const SOURCE_ROOT = resolve(PACKAGE_ROOT, "src");
export const CORE_SOURCE_ROOT = resolve(PACKAGE_ROOT, "../core/src");
/** Static files the shell needs at runtime; copied verbatim next to the built main process. */
export const RESOURCE_ROOT = resolve(PACKAGE_ROOT, "resources");
export const DIST_ROOT = resolve(PACKAGE_ROOT, "dist");
export const NODE_MAIN_FIELDS = ["module", "jsnext:main", "jsnext", "main"];
export const NODE_CONDITIONS = ["node"];

export const ALIASES = {
  "@preman/core": CORE_SOURCE_ROOT,
  "@preman/desktop": SOURCE_ROOT,
};

const NODE_BUILTINS = builtinModules.flatMap((moduleName) => {
  const bareName = moduleName.replace(/^node:/, "");
  return [bareName, `node:${bareName}`];
});

/**
 * The engine host runs the real engine, so it externalises exactly what the CLI does,
 * plus `electron` for `process.parentPort`'s types. `@preman/core` is deliberately
 * absent: the engine is inlined, the same way `dist/preman.js` inlines it.
 */
const ENGINE_RUNTIME_PACKAGES = [
  FAKER_MODULE,
  "@grpc/grpc-js",
  "@grpc/proto-loader",
  "yaml",
  ...SANDBOX_PACKAGES,
  ...Object.values(SANDBOX_ALIASES),
];

export const ENGINE_EXTERNALS = [...new Set([...NODE_BUILTINS, ...ENGINE_RUNTIME_PACKAGES, "electron"])];

/**
 * The shell entries inline what they pull, so anything they reach is visible in the bundle. Main
 * reaches `@preman/core/api/migrate.js` — a subtree of zod, `yaml` and `node:*`, and deliberately
 * not the barrel, which would drag `@grpc/grpc-js` in behind it.
 *
 * `yaml` is the one exception, and it is a correctness one rather than a size one. It ships a CJS
 * `dist/`, three of whose modules `require("process")`; inlined into an ESM output that becomes
 * rolldown's `__require`, which throws "in an environment that doesn't expose the `require`
 * function" the moment a migration loads. Externalising it emits a real `import` instead. It is
 * already a runtime dependency for the engine, so electron-builder was packing it either way.
 */
const SHELL_RUNTIME_PACKAGES = ["yaml"];

export const SHELL_EXTERNALS = [...new Set([...NODE_BUILTINS, ...SHELL_RUNTIME_PACKAGES, "electron"])];
