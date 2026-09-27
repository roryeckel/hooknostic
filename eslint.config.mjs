import eslint from "@eslint/js";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "examples/local-project/.hooknostic/artifacts/**",
      "**/node_modules/**",
      "**/*.snap.*",
      "fixtures/**",
      ".capture/**",
      // generated Agent Plugins extension outputs
      "examples/*/com.*/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Package build scripts, repo scripts, and test fixture servers run under Node.
    files: ["packages/*/scripts/**/*.mjs", "scripts/**/*.mjs", "packages/*/test/**/*.mjs", "examples/*/build/**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
      },
    },
  },
  {
    // Import order: node builtins, external packages, workspace packages,
    // then relative — the order the source already follows dominantly.
    // Longest-match routing sends `@hooknostic/*` here even though `^@?\w`
    // also matches it. Prettier runs after this fixer and tidies its spacing.
    plugins: { "simple-import-sort": simpleImportSort },
    rules: {
      "simple-import-sort/imports": [
        "error",
        {
          groups: [
            ["^\\u0000"], // side-effect imports
            ["^node:"], // node: builtins
            ["^@?\\w"], // external packages
            ["^@hooknostic/"], // workspace packages
            ["^\\."], // relative
          ],
        },
      ],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      // `unknown` payloads from vendor decode paths require controlled assertions.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
