import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

const SOURCE_FILES = ["packages/*/src/**/*.ts"];
const LEAF_FILES = [
  "packages/core/src/errors.ts",
  "packages/core/src/tls/**/*.ts",
  "packages/core/src/data/**/*.ts",
  "packages/core/src/vars/**/*.ts",
];
const CORE_FILES = ["packages/core/src/**/*.ts"];
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
const CORE_PURITY_IMPORTS = ["picocolors", "@inquirer/prompts", "@preman/cli", "@preman/cli/**"];
const CORE_PROCESS_PROPERTIES = ["stdout", "stderr", "stdin", "argv", "exit", "exitCode", "cwd"];
const CORE_PURITY_RULE =
  "The engine may not know it is a CLI: no colours, no prompts, no process I/O. Take it as input.";

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
