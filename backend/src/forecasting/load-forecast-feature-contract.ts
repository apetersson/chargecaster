import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { resolveMlFilePath } from "./model-paths";

const featureContractSchema = z.object({
  feature_schema_version: z.string().min(1),
  feature_names: z.array(z.string().min(1)).min(1),
});

type LoadForecastFeatureContract = z.infer<typeof featureContractSchema>;

function loadFeatureContract(): LoadForecastFeatureContract {
  const contractPath = resolveMlFilePath("load_forecast_feature_contract.json");
  const parsed = JSON.parse(readFileSync(contractPath, "utf-8")) as unknown;
  return featureContractSchema.parse(parsed);
}

export const loadForecastFeatureContract = loadFeatureContract();
export const LOAD_FORECAST_FEATURE_SCHEMA_VERSION = loadForecastFeatureContract.feature_schema_version;
export const LOAD_FORECAST_FEATURE_NAMES = [...loadForecastFeatureContract.feature_names];
export const LOAD_FORECAST_FEATURE_COUNT = LOAD_FORECAST_FEATURE_NAMES.length;

export function resolveLoadForecastFeatureContractPath(): string {
  return resolveMlFilePath("load_forecast_feature_contract.json");
}

export function resolveLoadForecastFeatureContractPythonPath(): string {
  return join(dirname(resolveMlFilePath("train_load_forecast.py")), "load_forecast_feature_contract.json");
}
