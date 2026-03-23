import base from "../../eslint.base.config";
import noRawUnitArithmeticRule from "../../eslint-rules/no-raw-unit-arithmetic";

export default [
  ...base,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/forecast-helpers.ts"],
    plugins: {
      chargecaster: {
        rules: {
          "no-raw-unit-arithmetic": noRawUnitArithmeticRule,
        },
      },
    },
    rules: {
      "chargecaster/no-raw-unit-arithmetic": "warn",
    },
  },
];
