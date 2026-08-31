import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

const WORKSPACE_ROOT = import.meta.dirname;
const CORE_SOURCE_ROOT = resolve(WORKSPACE_ROOT, "packages/core/src");
const CLI_SOURCE_ROOT = resolve(WORKSPACE_ROOT, "packages/cli/src");
const DESKTOP_SOURCE_ROOT = resolve(WORKSPACE_ROOT, "packages/desktop/src");
/**
 * Electron lives in the desktop package rather than at the root, so `electron` resolves to one id
 * from `packages/desktop/src/main/` and to nothing from `test/`. A `vi.mock("electron", …)` keyed
 * on the second would never be found by the first, which is a mock that silently does nothing.
 * Aliased so both spell the same module, which is what makes `main/hosts.ts` testable at all.
 */
const ELECTRON_MODULE = resolve(WORKSPACE_ROOT, "packages/desktop/node_modules/electron");
const TEST_FILES = ["test/**/*.test.ts"];
const TEST_TIMEOUT_MS = 20_000;
const NODE_MAIN_FIELDS = ["module", "jsnext:main", "jsnext", "main"];
const NODE_CONDITIONS = ["node"];
/**
 * The golden-output tests in `render.test.ts` and `commands.test.ts` compare against plain text,
 * on the assumption that picocolors paints nothing because a test run is not a TTY. That is only
 * two thirds of picocolors' rule: it also turns colour *on* whenever `CI` is set, so those
 * assertions passed on a laptop and failed on the runner. This makes the assumption true instead
 * of hoping for it. `test.env` reaches the worker that imports the code under test, which is where
 * picocolors decides, so this is the environment of the renderers rather than a global switch.
 */
const TEST_ENV = { NO_COLOR: "1" };

/** One Vitest project over one `test/fixtures/`; the packages only carry build config. */
export default defineConfig({
  resolve: {
    alias: {
      "@preman/core": CORE_SOURCE_ROOT,
      "@preman/cli": CLI_SOURCE_ROOT,
      // The engine host, exercised directly. Anything under `src/main` that imports `electron`
      // is testable only with `vi.mock("electron", …)`, which needs the alias below; `src/preload`
      // additionally needs a `contextBridge` to exist, so it stays read as text.
      "@preman/desktop": DESKTOP_SOURCE_ROOT,
      electron: ELECTRON_MODULE,
    },
    mainFields: NODE_MAIN_FIELDS,
    conditions: NODE_CONDITIONS,
  },
  test: {
    include: TEST_FILES,
    environment: "node",
    testTimeout: TEST_TIMEOUT_MS,
    env: TEST_ENV,
  },
});
