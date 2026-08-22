/**
 * What the four desktop entries agree on. Four `vite build` invocations rather than one
 * because main, preload, engine and renderer are four different runtimes, and pretending
 * otherwise is how a `node:fs` import ends up in a browser bundle.
 */
import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { SANDBOX_ALIASES, SANDBOX_PACKAGES } from "../core/src/scripts/module-names.js";

export const BUILD_TARGET = "node20";
export const PACKAGE_ROOT = import.meta.dirname;
export const SOURCE_ROOT = resolve(PACKAGE_ROOT, "src");
export const CORE_SOURCE_ROOT = resolve(PACKAGE_ROOT, "../core/src");
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
  "@faker-js/faker",
  "@grpc/grpc-js",
  "@grpc/proto-loader",
  "yaml",
  ...SANDBOX_PACKAGES,
  ...Object.values(SANDBOX_ALIASES),
];

export const ENGINE_EXTERNALS = [...new Set([...NODE_BUILTINS, ...ENGINE_RUNTIME_PACKAGES, "electron"])];

/** Main and preload touch no engine dependency, so anything they resolve is a mistake worth seeing. */
export const SHELL_EXTERNALS = [...new Set([...NODE_BUILTINS, "electron"])];
