import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import packageJson from "./package.json" with { type: "json" };
import { FAKER_MODULE, SANDBOX_ALIASES, SANDBOX_PACKAGES } from "../core/src/scripts/module-names.js";

const BUILD_TARGET = "node20";
const OUT_FILE = "preman.js";
const VERSION_ENV_VAR = "PREMAN_VERSION";
const PACKAGE_ROOT = import.meta.dirname;
const SOURCE_ROOT = resolve(PACKAGE_ROOT, "src");
const CORE_SOURCE_ROOT = resolve(PACKAGE_ROOT, "../core/src");
const ENTRY_FILE = resolve(SOURCE_ROOT, "bin.ts");
const NODE_MAIN_FIELDS = ["module", "jsnext:main", "jsnext", "main"];
const NODE_CONDITIONS = ["node"];
const RUNTIME_PACKAGES = [
  FAKER_MODULE,
  "@grpc/grpc-js",
  "@grpc/proto-loader",
  "@inquirer/prompts",
  "yaml",
  ...SANDBOX_PACKAGES,
  ...Object.values(SANDBOX_ALIASES),
];
const NODE_BUILTINS = builtinModules.flatMap((moduleName) => {
  const bareName = moduleName.replace(/^node:/, "");
  return [bareName, `node:${bareName}`];
});

/** `@preman/core` is deliberately absent: the engine is inlined so `dist/preman.js` stays one artifact. */
export const EXTERNAL_PACKAGES = [...new Set([...NODE_BUILTINS, ...RUNTIME_PACKAGES])];

export default defineConfig({
  define: {
    __PREMAN_VERSION__: JSON.stringify(process.env[VERSION_ENV_VAR] ?? packageJson.version),
  },
  resolve: {
    alias: {
      "@preman/core": CORE_SOURCE_ROOT,
      "@preman/cli": SOURCE_ROOT,
    },
    mainFields: NODE_MAIN_FIELDS,
    conditions: NODE_CONDITIONS,
  },
  build: {
    target: BUILD_TARGET,
    lib: {
      entry: ENTRY_FILE,
      formats: ["es"],
      fileName: () => OUT_FILE,
    },
    sourcemap: true,
    minify: false,
    rolldownOptions: {
      external: EXTERNAL_PACKAGES,
    },
  },
});
