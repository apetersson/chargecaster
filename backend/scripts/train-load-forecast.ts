import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

function resolveConfigPath(): string {
  return process.env.CHARGECASTER_CONFIG?.trim() || join(process.cwd(), "..", "config.local.yaml");
}

function resolveDbPath(): string {
  return process.env.CHARGECASTER_STORAGE_PATH?.trim() || join(process.cwd(), "..", "data", "db", "backend.sqlite");
}

function main(): void {
  const version = new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replaceAll("-", "");
  const outputDir = join(process.cwd(), "..", "data", "models", "load-forecast", version);
  mkdirSync(outputDir, { recursive: true });
  const args = [
    join(process.cwd(), "ml", "train_load_forecast.py"),
    "--config",
    resolveConfigPath(),
    "--db",
    resolveDbPath(),
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
