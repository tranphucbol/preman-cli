import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const SOURCE_FILES = ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"];
const LEAF_FILES = [
  "packages/core/src/errors.ts",
  "packages/core/src/tls/**/*.ts",
  "packages/core/src/data/**/*.ts",
  "packages/core/src/json/**/*.ts",
  "packages/core/src/vars/**/*.ts",
];
const CORE_FILES = ["packages/core/src/**/*.ts"];
const RENDERER_FILES = ["packages/desktop/src/renderer/**/*.ts", "packages/desktop/src/renderer/**/*.tsx"];
const TEST_FILES = ["test/**/*.ts"];
const SOURCE_LEAF_IMPORTS = [
  "@preman/cli/**",
  "@preman/core/runner.js",
  "@preman/core/grpc/**",
  "@preman/core/http/**",
  "@preman/core/scripts/**",
  "@preman/core/workspace/**",
];
const SOURCE_IMPORT_PATTERNS = ["../*", "../**"];
const TEST_SOURCE_IMPORT_PATTERNS = ["**/packages/*/src/*", "**/packages/*/src/**"];
const TYPE_IMPORT_RULE =
  "Cross-directory imports use @preman/core or @preman/cli; imports within a directory stay relative.";
const LEAF_IMPORT_RULE = "Leaf modules must not depend on command, runner, protocol, script, or workspace layers.";
/** Anything that presumes a terminal is reading. `process.env` stays legal: PREMAN_FAKER_SEED. */
const CORE_PURITY_IMPORTS = [
  "picocolors",
  "@inquirer/prompts",
  "@preman/cli",
  "@preman/cli/**",
  "electron",
  "electron/**",
];
const CORE_PROCESS_PROPERTIES = ["stdout", "stderr", "stdin", "argv", "exit", "exitCode", "cwd"];
const CORE_PURITY_RULE =
  "The engine may not know it is a CLI or a window: no colours, no prompts, no process I/O, no Electron.";
/**
 * The renderer is a browser. If it can `import { runRequest }`, someone eventually will, and the
 * app becomes Postman: one process holding the workspace, the engine and the view.
 */
const RENDERER_FENCE_IMPORTS = ["@preman/core", "@preman/core/**", "node:*", "electron", "electron/**"];
/** The renderer program resolves Node types through protocol.ts, so the globals need banning too. */
const RENDERER_FENCE_GLOBALS = ["process", "Buffer", "require", "__dirname", "__filename", "global"];
const RENDERER_FENCE_RULE =
  "The renderer is a pure view. Reach the engine over the port; import types from @preman/desktop/engine/protocol.js.";
/**
 * Motion is one module's dependency, not the renderer's. `ui/motion.tsx` owns the `LazyMotion`
 * boundary and re-exports `m`; anything else importing the library directly is how a 20 kB feature
 * bundle quietly becomes the 34 kB one. Decision 26.
 */
const MOTION_FENCE_IMPORTS = ["motion", "motion/**"];
const MOTION_FENCE_RULE =
  "Import `m` and `AnimatePresence` from @preman/desktop/renderer/ui/motion.js. Only that module may import motion directly.";
const MOTION_DOOR_FILES = ["packages/desktop/src/renderer/ui/motion.tsx"];
/**
 * DOM globals that read like props. `onClose={close}` type-checks, because `close` is
 * `window.close`, and then the button silently does nothing: this shipped once already. A local
 * binding of the same name shadows the global and is not reported, so callbacks and destructured
 * props are unaffected. Say `window.open(...)` when the window is genuinely what you meant.
 */
const RENDERER_SHADOWED_GLOBALS = [
  "close",
  "open",
  "name",
  "status",
  "length",
  "top",
  "parent",
  "self",
  "focus",
  "blur",
  "print",
  "stop",
  "origin",
  "event",
  "find",
  "scroll",
  "history",
  "location",
];
const RENDERER_SHADOW_RULE =
  "This is a DOM global, not a prop. Pass the value you meant, or reach through `window.` to be explicit.";

export default tseslint.config(
  {
    ignores: ["dist/**", "**/dist/**", "node_modules/**", "test/fixtures/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.js"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "inline-type-imports",
        },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: SOURCE_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: SOURCE_IMPORT_PATTERNS,
              message: TYPE_IMPORT_RULE,
            },
          ],
        },
      ],
    },
  },
  {
    files: CORE_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: SOURCE_IMPORT_PATTERNS,
              message: TYPE_IMPORT_RULE,
            },
            {
              group: CORE_PURITY_IMPORTS,
              message: CORE_PURITY_RULE,
            },
          ],
        },
      ],
      "no-restricted-properties": [
        "error",
        ...CORE_PROCESS_PROPERTIES.map((property) => ({
          object: "process",
          property,
          message: CORE_PURITY_RULE,
        })),
      ],
    },
  },
  {
    files: LEAF_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: SOURCE_IMPORT_PATTERNS,
              message: TYPE_IMPORT_RULE,
            },
            {
              group: CORE_PURITY_IMPORTS,
              message: CORE_PURITY_RULE,
            },
            {
              group: SOURCE_LEAF_IMPORTS,
              message: LEAF_IMPORT_RULE,
            },
          ],
        },
      ],
    },
  },
  {
    files: RENDERER_FILES,
    // The renderer is the only React in the tree, so rules-of-hooks is scoped to it rather than
    // applied globally. `recommended-latest` is the flat-config entry point and it carries both
    // `rules-of-hooks` (an error, always) and `exhaustive-deps` (a warning by default, promoted
    // here because a stale closure over a store action is a bug that only shows up under a race).
    extends: [reactHooks.configs.flat["recommended-latest"]],
    rules: {
      "react-hooks/exhaustive-deps": "error",
      // React Compiler is not enabled (no babel plugin in vite.renderer.config.ts), so its
      // "this library cannot be auto-memoized" advisories describe an optimisation we do not run.
      // TanStack Virtual trips it by design; the manual subscription rules in the stores are what
      // keep this app fast, not the compiler.
      "react-hooks/incompatible-library": "off",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: SOURCE_IMPORT_PATTERNS,
              message: TYPE_IMPORT_RULE,
            },
            {
              group: RENDERER_FENCE_IMPORTS,
              message: RENDERER_FENCE_RULE,
            },
            {
              group: MOTION_FENCE_IMPORTS,
              message: MOTION_FENCE_RULE,
            },
          ],
        },
      ],
      "no-restricted-globals": [
        "error",
        ...RENDERER_FENCE_GLOBALS.map((name) => ({ name, message: RENDERER_FENCE_RULE })),
        ...RENDERER_SHADOWED_GLOBALS.map((name) => ({ name, message: RENDERER_SHADOW_RULE })),
      ],
    },
  },
  {
    // The one exemption from the Motion fence. It re-declares the other two groups on purpose:
    // `no-restricted-imports` is replaced wholesale by a later config object rather than merged
    // into, so omitting them would exempt this file from the engine and `node:*` fences as well -
    // the fence decision 2 calls the whole architecture.
    files: MOTION_DOOR_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: SOURCE_IMPORT_PATTERNS,
              message: TYPE_IMPORT_RULE,
            },
            {
              group: RENDERER_FENCE_IMPORTS,
              message: RENDERER_FENCE_RULE,
            },
          ],
        },
      ],
    },
  },
  {
    files: TEST_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: TEST_SOURCE_IMPORT_PATTERNS,
              message: TYPE_IMPORT_RULE,
            },
          ],
        },
      ],
    },
  },
  prettier,
);
