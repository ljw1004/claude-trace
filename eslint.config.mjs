import js from "@eslint/js";
import tseslint from "typescript-eslint";

const tsFiles = ["*.ts"];

export default tseslint.config(
  {
    ignores: ["node_modules/", "viewer.js", "bun-src/"],
  },
  {
    ...js.configs.recommended,
    rules: {
      ...js.configs.recommended.rules,
      curly: "error",
      "no-eval": "error",
      "no-restricted-properties": [
        "error",
        {
          object: "module",
          property: "exports",
          message: "Use ES module exports in this project.",
        },
      ],
      "prefer-const": "error",
    },
  },
  ...tseslint.configs.strictTypeChecked.map((config) => ({
    ...config,
    files: tsFiles,
  })),
  {
    files: tsFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: tsFiles,
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
);
