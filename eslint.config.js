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
