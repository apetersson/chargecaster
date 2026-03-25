import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { resolvePriceForecastBaseDir, resolveBackendDbPath } from "../src/forecasting/model-paths";

function resolveConfigPath(): string {
  return process.env.CHARGECASTER_CONFIG?.trim() || join(process.cwd(), "..", "config.local.yaml");
}

function main(): void {
  const version = new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replaceAll("-", "");
  const outputDir = join(resolvePriceForecastBaseDir(), `manual-${version}`);
  mkdirSync(outputDir, { recursive: true });
  const args = [
    join(process.cwd(), "ml", "train_price_forecast.py"),
    "--config",
    resolveConfigPath(),
    "--db",
    resolveBackendDbPath(),
    "--output-dir",
    outputDir,
  ];
  const result = spawnSync("python3", args, { stdio: "inherit", cwd: process.cwd() });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
  if (!existsSync(join(outputDir, "manifest.json"))) {
    throw new Error(`Training completed without manifest.json in ${outputDir}`);
  }
}

main();
