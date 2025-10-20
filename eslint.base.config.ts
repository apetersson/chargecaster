import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import eslintPluginImport from "eslint-plugin-import";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js}"],
    ignores: ["dist*", "node_modules", "coverage"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        projectService: true,
      },
      sourceType: "module",
    },
    plugins: {
      "@typescript-eslint": tseslint,
      import: eslintPluginImport,
    },
    rules: {
      ...tseslint.configs["recommended-type-checked"].rules,
      ...tseslint.configs["stylistic-type-checked"].rules,
      ...eslintConfigPrettier.rules,
      "import/order": "off",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { attributes: false } }],
      "@typescript-eslint/consistent-type-definitions": "off",
      "@typescript-eslint/non-nullable-type-assertion-style": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/array-type": "off",
      "@typescript-eslint/prefer-optional-chain": "off",
    },
  },
];
