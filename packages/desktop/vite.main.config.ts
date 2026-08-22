import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import {
  ALIASES,
  BUILD_TARGET,
  DIST_ROOT,
  NODE_CONDITIONS,
  NODE_MAIN_FIELDS,
  RESOURCE_ROOT,
  SHELL_EXTERNALS,
  SOURCE_ROOT,
} from "./vite.shared.js";

const OUT_FILE = "main.js";
const ICON_FILE = "icon.png";

/**
 * Puts the app icon beside `main.js`, where `distPath` finds it in dev and packaged alike.
 * Named rather than `publicDir` because `resources/` also holds the icon's source art and the
 * script that reshapes it, and neither belongs in a shipped app.
 */
function icon(): Plugin {
  return {
    name: "preman-icon",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: ICON_FILE,
        source: readFileSync(resolve(RESOURCE_ROOT, ICON_FILE)),
      });
    },
  };
}

export default defineConfig({
  plugins: [icon()],
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
