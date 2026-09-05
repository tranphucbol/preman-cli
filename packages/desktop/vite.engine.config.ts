import { resolve } from "node:path";
import { defineConfig } from "vite";
import {
  ALIASES,
  BUILD_TARGET,
  DIST_ROOT,
  ENGINE_EXTERNALS,
  NODE_CONDITIONS,
  NODE_MAIN_FIELDS,
  SOURCE_ROOT,
} from "./vite.shared.js";
import { vendorProtos } from "../core/vite.vendor.js";

const OUT_FILE = "entry.js";

export default defineConfig({
  plugins: [vendorProtos()],
  resolve: { alias: ALIASES, mainFields: NODE_MAIN_FIELDS, conditions: NODE_CONDITIONS },
  build: {
    target: BUILD_TARGET,
    outDir: resolve(DIST_ROOT, "engine"),
    emptyOutDir: true,
    lib: {
      entry: resolve(SOURCE_ROOT, "engine/entry.ts"),
      formats: ["es"],
      fileName: () => OUT_FILE,
    },
    sourcemap: true,
    minify: false,
    rolldownOptions: { external: ENGINE_EXTERNALS },
  },
});
