import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
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
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      // `unknown` payloads from vendor decode paths require controlled assertions.
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
