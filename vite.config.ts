import { builtinModules } from "node:module";
import { resolve } from "node:path";
import packageJson from "./package.json" with { type: "json" };
import { defineConfig } from "vitest/config";
import { SANDBOX_ALIASES, SANDBOX_PACKAGES } from "./src/scripts/module-names.js";

const BUILD_TARGET = "node20";
const OUT_FILE = "preman.js";
const VERSION_ENV_VAR = "PREMAN_VERSION";
const PROJECT_ROOT = import.meta.dirname;
const SOURCE_ROOT = resolve(PROJECT_ROOT, "src");
const ENTRY_FILE = resolve(SOURCE_ROOT, "cli.ts");
const TEST_FILES = ["test/**/*.test.ts"];
const TEST_TIMEOUT_MS = 20_000;
const NODE_MAIN_FIELDS = ["module", "jsnext:main", "jsnext", "main"];
const NODE_CONDITIONS = ["node"];
const RUNTIME_PACKAGES = [
  "@faker-js/faker",
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

export const EXTERNAL_PACKAGES = [...new Set([...NODE_BUILTINS, ...RUNTIME_PACKAGES])];

export default defineConfig({
  define: {
    __PREMAN_VERSION__: JSON.stringify(process.env[VERSION_ENV_VAR] ?? packageJson.version),
  },
  resolve: {
    alias: {
      "@": SOURCE_ROOT,
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
  test: {
    include: TEST_FILES,
    environment: "node",
    testTimeout: TEST_TIMEOUT_MS,
  },
});
