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

const OUT_FILE = "main.js";

export default defineConfig({
  resolve: { alias: ALIASES, mainFields: NODE_MAIN_FIELDS, conditions: NODE_CONDITIONS },
  build: {
    target: BUILD_TARGET,
    outDir: resolve(DIST_ROOT, "main"),
    emptyOutDir: true,
    lib: {
      entry: resolve(SOURCE_ROOT, "main/main.ts"),
      formats: ["es"],
      fileName: () => OUT_FILE,
    },
    sourcemap: true,
    minify: false,
    rolldownOptions: { external: SHELL_EXTERNALS },
  },
});
