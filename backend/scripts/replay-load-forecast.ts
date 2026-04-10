import { argv, exit } from "node:process";

import YAML from "yaml";
import { readFileSync } from "node:fs";

import { parseConfigDocument } from "../src/config/schemas";
import { evaluateAndPersistLoadForecastReplay } from "../src/forecasting/load-forecast-replay";
import { StorageService } from "../src/storage/storage.service";

type Options = {
  configPath: string;
  dbPath: string;
  modelDir: string;
  days: number;
  horizonHours: number;
};

function parseArgs(rawArgs: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < rawArgs.length; index += 1) {
    const key = rawArgs[index];
    const value = rawArgs[index + 1];
    if (!key?.startsWith("--") || value == null) {
      continue;
    }
    values.set(key.slice(2), value);
    index += 1;
  }

  const configPath = values.get("config");
  const dbPath = values.get("db");
  const modelDir = values.get("model-dir");
  if (!configPath || !dbPath || !modelDir) {
    throw new Error("Expected --config, --db, and --model-dir");
  }

  return {
    configPath,
    dbPath,
    modelDir,
    days: Math.max(1, Number(values.get("days") ?? "14")),
    horizonHours: Math.max(1, Number(values.get("horizon-hours") ?? "24")),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(argv.slice(2));
  process.env.CHARGECASTER_STORAGE_PATH = options.dbPath;

  const config = parseConfigDocument(YAML.parse(readFileSync(options.configPath, "utf-8")));
  const storage = new StorageService();
  try {
    const summary = await evaluateAndPersistLoadForecastReplay({
      config,
      storage,
      versionDir: options.modelDir,
      days: options.days,
      horizonHours: options.horizonHours,
    });
    console.log(`Replay windows: ${summary.window_count}`);
    console.log(`METRIC cost_delta_eur=${summary.cost_delta_eur.toFixed(6)}`);
    console.log(`METRIC mae=${summary.mae.toFixed(6)}`);
    console.log(`METRIC p90_economic_hours_absolute_error=${summary.p90_economic_hours_absolute_error.toFixed(6)}`);
    console.log(`METRIC mode_switch_count=${summary.mode_switch_count.toFixed(6)}`);
    console.log(`METRIC mode_switch_delta=${summary.mode_switch_delta.toFixed(6)}`);
  } finally {
    storage.onModuleDestroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  exit(1);
});
