import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";

import type { ConfigDocument } from "../config/schemas";

export const PRICE_FORECAST_FEATURE_SCHEMA_VERSION = "v1_price_total_1";

const metricsSummarySchema = z.object({
  mae: z.number(),
  rmse: z.number(),
  p50_absolute_error: z.number(),
  p90_absolute_error: z.number(),
  mae_vs_heuristic_improvement_ratio: z.number().optional(),
});

const trainingWindowSchema = z.object({
  start: z.string(),
  end: z.string(),
});

export const priceForecastManifestSchema = z.object({
  model_type: z.literal("catboost"),
  model_version: z.string(),
  feature_schema_version: z.string(),
  trained_at: z.string(),
  training_window: trainingWindowSchema,
  history_row_count: z.number().int().nonnegative(),
  hourly_row_count: z.number().int().nonnegative(),
  metrics_summary: metricsSummarySchema,
  catboost_version: z.string(),
});

export type PriceForecastManifest = z.infer<typeof priceForecastManifestSchema>;

export interface ActivePriceForecastArtifact {
  baseDir: string;
  currentDir: string;
  modelPath: string;
  manifestPath: string;
  metricsPath: string;
  trainingLogPath: string;
  manifest: PriceForecastManifest;
}

@Injectable()
export class PriceForecastArtifactService {
  private readonly logger = new Logger(PriceForecastArtifactService.name);

  resolveBaseDir(config: ConfigDocument): string {
    const configured = config.price_forecast?.model_dir?.trim();
    return configured && configured.length > 0
      ? resolve(process.cwd(), configured)
      : join(process.cwd(), "..", "data", "models", "price-forecast");
  }

  resolveCurrentDir(config: ConfigDocument): string {
    return join(this.resolveBaseDir(config), "current");
  }

  ensureBaseDir(config: ConfigDocument): string {
    const baseDir = this.resolveBaseDir(config);
    mkdirSync(baseDir, { recursive: true });
    return baseDir;
  }

  readActiveArtifact(config: ConfigDocument): ActivePriceForecastArtifact | null {
    const currentDir = this.resolveCurrentDir(config);
    const manifestPath = join(currentDir, "manifest.json");
    const modelPath = join(currentDir, "model.cbm");
    const metricsPath = join(currentDir, "metrics.json");
    const trainingLogPath = join(currentDir, "training.log");
    if (!existsSync(currentDir) || !existsSync(manifestPath) || !existsSync(modelPath)) {
      return null;
    }

    try {
      const manifest = priceForecastManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf-8")));
      if (manifest.feature_schema_version !== PRICE_FORECAST_FEATURE_SCHEMA_VERSION) {
        this.logger.warn(
          `Ignoring price-forecast artifact ${manifest.model_version}: schema ${manifest.feature_schema_version} != ${PRICE_FORECAST_FEATURE_SCHEMA_VERSION}`,
        );
        return null;
      }
      return {
        baseDir: this.resolveBaseDir(config),
        currentDir,
        modelPath,
        manifestPath,
        metricsPath,
        trainingLogPath,
        manifest,
      };
    } catch (error) {
      this.logger.warn(`Ignoring invalid price-forecast artifact in ${currentDir}: ${String(error)}`);
      return null;
    }
  }

  promoteVersion(config: ConfigDocument, versionDir: string): void {
    const baseDir = this.ensureBaseDir(config);
    const currentDir = join(baseDir, "current");
    const nextDir = join(baseDir, "current.next");
    const backupDir = join(baseDir, "current.previous");
    rmSync(nextDir, { recursive: true, force: true });
    rmSync(backupDir, { recursive: true, force: true });
    cpSync(versionDir, nextDir, { recursive: true });
    mkdirSync(dirname(currentDir), { recursive: true });
    if (existsSync(currentDir)) {
      renameSync(currentDir, backupDir);
    }
    renameSync(nextDir, currentDir);
    rmSync(backupDir, { recursive: true, force: true });
    rmSync(nextDir, { recursive: true, force: true });
  }

  writePromotionMarker(versionDir: string): void {
    writeFileSync(join(versionDir, ".promoted"), new Date().toISOString(), "utf-8");
  }
}
