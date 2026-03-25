import { basename, dirname, join, resolve } from "node:path";

function resolveStoragePath(): string {
  const override = process.env.CHARGECASTER_STORAGE_PATH?.trim();
  return override && override.length > 0
    ? resolve(process.cwd(), override)
    : join(process.cwd(), "..", "data", "db", "backend.sqlite");
}

function resolveModelsRootDir(): string {
  const dbPath = resolveStoragePath();
  const dbDir = dirname(dbPath);
  const modelsParent = basename(dbDir) === "db" ? dirname(dbDir) : dbDir;
  return join(modelsParent, "models");
}

export function resolveLoadForecastBaseDir(): string {
  const override = process.env.CHARGECASTER_LOAD_FORECAST_MODEL_DIR?.trim();
  return override && override.length > 0
    ? resolve(process.cwd(), override)
    : join(resolveModelsRootDir(), "load-forecast");
}

export function resolvePriceForecastBaseDir(): string {
  const override = process.env.CHARGECASTER_PRICE_FORECAST_MODEL_DIR?.trim();
  return override && override.length > 0
    ? resolve(process.cwd(), override)
    : join(resolveModelsRootDir(), "price-forecast");
}

export function resolveBackendDbPath(): string {
  return resolveStoragePath();
}
