import base from "../eslint.base.config";
import tseslint from "@typescript-eslint/eslint-plugin";
import reactPlugin from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";
import globals from "globals";

export default [
  ...base,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      react: reactPlugin,
      "react-hooks": reactHooks,
      "jsx-a11y": jsxA11y,
    },
    settings: {
      react: { version: "detect" },
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "react/jsx-no-leaked-render": "warn",
      "react/no-unstable-nested-components": "warn",
      "react/no-array-index-key": "warn",
      "react/function-component-definition": ["warn", {
        namedComponents: "function-declaration",
        unnamedComponents: "arrow-function",
      }],
      "react/no-danger": "warn",
      "jsx-a11y/no-autofocus": "warn",
      "jsx-a11y/anchor-has-content": "warn",
      "jsx-a11y/label-has-associated-control": "warn",
      "import/no-cycle": ["error", { maxDepth: 1 }],
      // React 17+ JSX transform
      "react/jsx-uses-react": "error",
      "react/react-in-jsx-scope": "off",
    },
  },
];
