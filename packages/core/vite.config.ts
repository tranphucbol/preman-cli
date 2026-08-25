import { builtinModules } from "node:module";
import { resolve } from "node:path";
import { defineConfig } from "vite";
import { FAKER_MODULE, SANDBOX_ALIASES, SANDBOX_PACKAGES } from "./src/scripts/module-names.js";

const BUILD_TARGET = "node20";
const OUT_FILE = "core.js";
const PACKAGE_ROOT = import.meta.dirname;
const SOURCE_ROOT = resolve(PACKAGE_ROOT, "src");
const ENTRY_FILE = resolve(SOURCE_ROOT, "index.ts");
const NODE_MAIN_FIELDS = ["module", "jsnext:main", "jsnext", "main"];
const NODE_CONDITIONS = ["node"];
const RUNTIME_PACKAGES = [
  FAKER_MODULE,
  "@grpc/grpc-js",
  "@grpc/proto-loader",
  "yaml",
  ...SANDBOX_PACKAGES,
  ...Object.values(SANDBOX_ALIASES),
];
const NODE_BUILTINS = builtinModules.flatMap((moduleName) => {
  const bareName = moduleName.replace(/^node:/, "");
  return [bareName, `node:${bareName}`];
});

export const EXTERNAL_PACKAGES = [...new Set([...NODE_BUILTINS, ...RUNTIME_PACKAGES])];

/** Core is never published as a bundle; this build only proves the boundary compiles standalone. */
export default defineConfig({
  resolve: {
    alias: {
      "@preman/core": SOURCE_ROOT,
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
