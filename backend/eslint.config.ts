import base from "../eslint.base.config";
import globals from "globals";
import noRawUnitArithmeticRule from "../eslint-rules/no-raw-unit-arithmetic";

export default [
  ...base,
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
  },
  {
    files: [
      "src/simulation/optimal-schedule.ts",
      "src/simulation/battery-efficiency.service.ts",
      "src/simulation/daily-isolated-backtest.strategy.ts",
      "src/simulation/simulation.service.ts",
    ],
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
