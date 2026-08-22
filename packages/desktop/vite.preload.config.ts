import { resolve } from "node:path";
import { defineConfig } from "vite";
import {
  ALIASES,
  BUILD_TARGET,
  DIST_ROOT,
  NODE_CONDITIONS,
  NODE_MAIN_FIELDS,
  SHELL_EXTERNALS,
  SOURCE_ROOT,
} from "./vite.shared.js";

/** CommonJS, not a choice: a sandboxed preload script cannot be an ES module. */
const OUT_FILE = "preload.cjs";

export default defineConfig({
  resolve: { alias: ALIASES, mainFields: NODE_MAIN_FIELDS, conditions: NODE_CONDITIONS },
  build: {
    target: BUILD_TARGET,
    outDir: resolve(DIST_ROOT, "preload"),
    emptyOutDir: true,
    lib: {
      entry: resolve(SOURCE_ROOT, "preload/preload.ts"),
      formats: ["cjs"],
      fileName: () => OUT_FILE,
    },
    sourcemap: true,
    minify: false,
    rolldownOptions: { external: SHELL_EXTERNALS },
  },
});
