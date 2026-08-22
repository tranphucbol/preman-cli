import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { defineConfig } from "vite";

import { ALIASES, DIST_ROOT, SOURCE_ROOT } from "./vite.shared.js";

// The renderer is the only browser target in the repo. `base` is relative because the packaged
// app loads it over `file://`, where an absolute `/assets/...` resolves to the filesystem root.
const RENDERER_ROOT = resolve(SOURCE_ROOT, "renderer");
const RENDERER_TARGET = "chrome130";
const RELATIVE_BASE = "./";

export default defineConfig({
  root: RENDERER_ROOT,
  base: RELATIVE_BASE,
  // Tailwind v4 has no config file: `src/renderer/app.css` is the design system, and the plugin
  // generates only the utilities this directory actually names.
  plugins: [react(), tailwindcss()],
  resolve: { alias: ALIASES },
  build: {
    target: RENDERER_TARGET,
    outDir: resolve(DIST_ROOT, "renderer"),
    emptyOutDir: true,
    sourcemap: true,
  },
});
