import { spawnSync } from "node:child_process";
import { join } from "node:path";

function resolveConfigPath(): string {
  return process.env.CHARGECASTER_CONFIG?.trim() || join(process.cwd(), "..", "config.local.yaml");
}

function resolveDbPath(): string {
  return process.env.CHARGECASTER_STORAGE_PATH?.trim() || join(process.cwd(), "..", "data", "db", "backend.sqlite");
}

function resolveModelPath(): string {
  return process.argv[2] || join(process.cwd(), "..", "data", "models", "load-forecast", "current", "model.cbm");
}

function main(): void {
  const args = [
    join(process.cwd(), "ml", "evaluate_load_forecast.py"),
    "--config",
    resolveConfigPath(),
    "--db",
    resolveDbPath(),
    "--model",
    resolveModelPath(),
  ];
  const result = spawnSync("python3", args, { stdio: "inherit", cwd: process.cwd() });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

main();
