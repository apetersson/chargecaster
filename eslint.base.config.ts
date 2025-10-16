import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import eslintPluginImport from "eslint-plugin-import";

export default [
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js}"],
    ignores: ["dist*", "node_modules", "coverage"],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      "@typescript-eslint": tseslint,
      import: eslintPluginImport,
    },
    rules: {
      // Keep base rules minimal; type-aware rules added per package configs
      "import/order": "off",
    },
  },
];
