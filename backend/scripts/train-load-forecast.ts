import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import YAML from "yaml";

import { parseConfigDocument, resolveLoadForecastPythonExecutable } from "../src/config/schemas";
import { evaluateAndPersistLoadForecastReplay } from "../src/forecasting/load-forecast-replay";
import { resolveBackendDbPath, resolveLoadForecastBaseDir, resolveMlScriptPath } from "../src/forecasting/model-paths";
import { StorageService } from "../src/storage/storage.service";

function resolveConfigPath(): string {
  return process.env.CHARGECASTER_CONFIG?.trim() || join(process.cwd(), "..", "config.local.yaml");
}

async function main(): Promise<void> {
  const configPath = resolveConfigPath();
  const config = parseConfigDocument(YAML.parse(readFileSync(configPath, "utf-8")));
  const dbPath = resolveBackendDbPath();
  const version = new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replaceAll("-", "");
  const outputDir = join(resolveLoadForecastBaseDir(config), version);
  mkdirSync(outputDir, { recursive: true });
  const args = [
    resolveMlScriptPath("train_load_forecast.py"),
    "--config",
    configPath,
    "--db",
    dbPath,
    "--output-dir",
    outputDir,
  ];
  const result = spawnSync(resolveLoadForecastPythonExecutable(config), args, { stdio: "inherit", cwd: process.cwd() });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  if (!existsSync(join(outputDir, "manifest.json"))) {
    throw new Error(`Training completed without manifest.json in ${outputDir}`);
  }

  process.env.CHARGECASTER_STORAGE_PATH = dbPath;
  const storage = new StorageService();
  try {
    await evaluateAndPersistLoadForecastReplay({
      config,
      storage,
      versionDir: outputDir,
    });
  } finally {
    storage.onModuleDestroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
