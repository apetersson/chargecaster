import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  LOAD_FORECAST_FEATURE_COUNT,
  LOAD_FORECAST_FEATURE_NAMES,
  LOAD_FORECAST_FEATURE_SCHEMA_VERSION,
  resolveLoadForecastFeatureContractPath,
} from "../src/forecasting/load-forecast-feature-contract";

describe("load-forecast feature contract", () => {
  it("keeps the runtime constants in parity with the shared JSON contract", () => {
    const contract = JSON.parse(readFileSync(resolveLoadForecastFeatureContractPath(), "utf-8")) as {
      feature_schema_version: string;
      feature_names: string[];
    };

    expect(LOAD_FORECAST_FEATURE_SCHEMA_VERSION).toBe(contract.feature_schema_version);
    expect(LOAD_FORECAST_FEATURE_NAMES).toEqual(contract.feature_names);
    expect(LOAD_FORECAST_FEATURE_COUNT).toBe(contract.feature_names.length);
  });
});
