import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

const SOURCE_FILES = ["src/**/*.ts"];
const LEAF_FILES = ["src/errors.ts", "src/tls/**/*.ts", "src/data/**/*.ts", "src/vars/**/*.ts"];
const OUTPUT_FILES = ["src/output/**/*.ts"];
const TEST_FILES = ["test/**/*.ts"];
const SOURCE_LEAF_IMPORTS = [
  "@/commands/**",
  "@/runner.js",
  "@/output/**",
  "@/grpc/**",
  "@/http/**",
  "@/scripts/**",
  "@/workspace/**",
];
const SOURCE_IMPORT_PATTERNS = ["../*", "../**"];
const TEST_SOURCE_IMPORT_PATTERNS = ["**/src/*", "**/src/**"];
const TYPE_IMPORT_RULE = "Cross-directory imports use @/; imports within a directory stay relative.";
const LEAF_IMPORT_RULE =
  "Leaf modules must not depend on command, runner, protocol, script, output, or workspace layers.";
const OUTPUT_IMPORT_RULE = "Output may depend on runner types but not runner values.";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "test/fixtures/**"],
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
    files: OUTPUT_FILES,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/runner.js",
              allowTypeImports: true,
              message: OUTPUT_IMPORT_RULE,
            },
          ],
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
