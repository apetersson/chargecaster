import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import type { ConfigDocument } from "../config/schemas";

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

export function resolveLoadForecastBaseDir(config?: ConfigDocument): string {
  const override = process.env.CHARGECASTER_LOAD_FORECAST_MODEL_DIR?.trim();
  const configured = config?.load_forecast?.model_dir?.trim();
  return override && override.length > 0
    ? resolve(process.cwd(), override)
    : configured && configured.length > 0
      ? resolve(process.cwd(), configured)
      : join(resolveModelsRootDir(), "load-forecast");
}

export function resolvePriceForecastBaseDir(config?: ConfigDocument): string {
  const override = process.env.CHARGECASTER_PRICE_FORECAST_MODEL_DIR?.trim();
  void config;
  return override && override.length > 0
    ? resolve(process.cwd(), override)
    : join(resolveModelsRootDir(), "price-forecast");
}

export function resolveBackendDbPath(): string {
  return resolveStoragePath();
}

export function resolveMlScriptPath(scriptName: string): string {
  const override = process.env.CHARGECASTER_ML_DIR?.trim();
  if (override && override.length > 0) {
    return join(resolve(process.cwd(), override), scriptName);
  }

  const candidates = [
    join(process.cwd(), "ml", scriptName),
    join(process.cwd(), "backend", "ml", scriptName),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function resolveMlFilePath(fileName: string): string {
  const override = process.env.CHARGECASTER_ML_DIR?.trim();
  if (override && override.length > 0) {
    return join(resolve(process.cwd(), override), fileName);
  }

  const candidates = [
    join(process.cwd(), "ml", fileName),
    join(process.cwd(), "backend", "ml", fileName),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

export function resolveBundledLoadForecastCurrentDir(): string | null {
  const override = process.env.CHARGECASTER_BUNDLED_LOAD_FORECAST_DIR?.trim();
  if (override && override.length > 0) {
    const resolved = resolve(process.cwd(), override);
    if (existsSync(join(resolved, "manifest.json"))) {
      return resolved;
    }
    const nestedCurrent = join(resolved, "current");
    return existsSync(join(nestedCurrent, "manifest.json")) ? nestedCurrent : null;
  }

  const candidates = [
    join(process.cwd(), "assets", "load-forecast", "current"),
    join(process.cwd(), "backend", "assets", "load-forecast", "current"),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "manifest.json"))) ?? null;
}
