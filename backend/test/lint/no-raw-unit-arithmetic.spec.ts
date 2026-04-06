import { join } from "node:path";
import { ESLint } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { beforeAll, describe, expect, it } from "vitest";

import noRawUnitArithmeticRule from "../../../eslint-rules/no-raw-unit-arithmetic";

const backendRoot = join(import.meta.dirname, "../..");
const backendTsconfig = join(backendRoot, "tsconfig.json");

type EslintOptions = NonNullable<ConstructorParameters<typeof ESLint>[0]>;
type OverrideConfig = NonNullable<EslintOptions["overrideConfig"]>;
type FlatConfigItem = OverrideConfig extends readonly (infer Item)[] ? Item : OverrideConfig;
type FlatPlugin = NonNullable<FlatConfigItem extends { plugins?: infer Plugins } ? Plugins : never>[string];

const chargecasterPlugin = {
  rules: {
    "no-raw-unit-arithmetic": noRawUnitArithmeticRule,
  },
} as unknown as FlatPlugin;

function createEslint(): ESLint {
  return new ESLint({
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ["**/*.ts"],
        languageOptions: {
          parser: tsParser,
          parserOptions: {
            project: backendTsconfig,
            tsconfigRootDir: backendRoot,
          },
        },
        plugins: {
          chargecaster: chargecasterPlugin,
        },
        rules: {
          "chargecaster/no-raw-unit-arithmetic": "warn",
        },
      },
    ],
  });
}

const fixtureDir = join(backendRoot, "test/lint/fixtures");

function fixturePath(filename: string): string {
  return join(fixtureDir, filename);
}

let eslint: ESLint;

describe("no-raw-unit-arithmetic rule", () => {
  beforeAll(() => {
    eslint = createEslint();
  });

  it("flags raw numeric arithmetic on unit-bearing names", async () => {
    const filePath = fixturePath("no-raw-unit-arithmetic.invalid.ts");

    const [result] = await eslint.lintFiles([filePath]);

    expect(result.messages.some((message) => message.ruleId === "chargecaster/no-raw-unit-arithmetic")).toBe(true);
  }, 15_000);

  it("allows domain-object calculations", async () => {
    const filePath = fixturePath("no-raw-unit-arithmetic.valid.ts");

    const [result] = await eslint.lintFiles([filePath]);

    expect(result.messages.some((message) => message.ruleId === "chargecaster/no-raw-unit-arithmetic")).toBe(false);
  }, 15_000);

  it("respects an explicit suppression comment", async () => {
    const filePath = fixturePath("no-raw-unit-arithmetic.suppressed.ts");

    const [result] = await eslint.lintFiles([filePath]);

    expect(result.messages.some((message) => message.ruleId === "chargecaster/no-raw-unit-arithmetic")).toBe(false);
  }, 15_000);
});
