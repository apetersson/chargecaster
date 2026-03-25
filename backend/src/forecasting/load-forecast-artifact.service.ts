import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";

import type { ConfigDocument } from "../config/schemas";
import { resolveBundledLoadForecastCurrentDir, resolveLoadForecastBaseDir } from "./model-paths";

export const LOAD_FORECAST_FEATURE_SCHEMA_VERSION = "v2_house_load_1";

const metricsSummarySchema = z.object({
  mae: z.number(),
  rmse: z.number(),
  p50_absolute_error: z.number(),
  p90_absolute_error: z.number(),
  mae_vs_hybrid_improvement_ratio: z.number().optional(),
  p90_economic_hours_absolute_error: z.number().optional(),
});

const trainingWindowSchema = z.object({
  start: z.string(),
  end: z.string(),
});

export const loadForecastManifestSchema = z.object({
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

export type LoadForecastManifest = z.infer<typeof loadForecastManifestSchema>;

export interface ActiveLoadForecastArtifact {
  baseDir: string;
  currentDir: string;
  modelPath: string;
  manifestPath: string;
  metricsPath: string;
  trainingLogPath: string;
  manifest: LoadForecastManifest;
}

@Injectable()
export class LoadForecastArtifactService {
  private readonly logger = new Logger(LoadForecastArtifactService.name);

  resolveBaseDir(config: ConfigDocument): string {
    void config;
    return resolveLoadForecastBaseDir();
  }

  resolveCurrentDir(config: ConfigDocument): string {
    return join(this.resolveBaseDir(config), "current");
  }

  ensureBaseDir(config: ConfigDocument): string {
    const baseDir = this.resolveBaseDir(config);
    mkdirSync(baseDir, { recursive: true });
    return baseDir;
  }

  readActiveArtifact(config: ConfigDocument): ActiveLoadForecastArtifact | null {
    this.seedBundledStarterArtifact(config);

    const currentDir = this.resolveCurrentDir(config);
    const manifestPath = join(currentDir, "manifest.json");
    const modelPath = join(currentDir, "model.cbm");
    const metricsPath = join(currentDir, "metrics.json");
    const trainingLogPath = join(currentDir, "training.log");
    if (!existsSync(currentDir) || !existsSync(manifestPath) || !existsSync(modelPath)) {
      return null;
    }

    try {
      const manifest = loadForecastManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf-8")));
      if (manifest.feature_schema_version !== LOAD_FORECAST_FEATURE_SCHEMA_VERSION) {
        this.logger.warn(
          `Ignoring load-forecast artifact ${manifest.model_version}: schema ${manifest.feature_schema_version} != ${LOAD_FORECAST_FEATURE_SCHEMA_VERSION}`,
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
      this.logger.warn(`Ignoring invalid load-forecast artifact in ${currentDir}: ${String(error)}`);
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

  private seedBundledStarterArtifact(config: ConfigDocument): void {
    const currentDir = this.resolveCurrentDir(config);
    if (existsSync(join(currentDir, "manifest.json")) && existsSync(join(currentDir, "model.cbm"))) {
      return;
    }

    const bundledCurrentDir = resolveBundledLoadForecastCurrentDir();
    if (!bundledCurrentDir) {
      return;
    }

    const bundledManifestPath = join(bundledCurrentDir, "manifest.json");
    const bundledModelPath = join(bundledCurrentDir, "model.cbm");
    if (!existsSync(bundledManifestPath) || !existsSync(bundledModelPath)) {
      return;
    }

    try {
      const manifest = loadForecastManifestSchema.parse(JSON.parse(readFileSync(bundledManifestPath, "utf-8")));
      if (manifest.feature_schema_version !== LOAD_FORECAST_FEATURE_SCHEMA_VERSION) {
        this.logger.warn(
          `Ignoring bundled load-forecast artifact ${manifest.model_version}: schema ${manifest.feature_schema_version} != ${LOAD_FORECAST_FEATURE_SCHEMA_VERSION}`,
        );
        return;
      }
      const baseDir = this.ensureBaseDir(config);
      const nextDir = join(baseDir, "current.next");
      rmSync(nextDir, { recursive: true, force: true });
      cpSync(bundledCurrentDir, nextDir, { recursive: true });
      rmSync(currentDir, { recursive: true, force: true });
      renameSync(nextDir, currentDir);
      this.logger.log(`Seeded bundled load-forecast starter model ${manifest.model_version} into ${currentDir}`);
    } catch (error) {
      this.logger.warn(`Failed to seed bundled load-forecast starter artifact from ${bundledCurrentDir}: ${String(error)}`);
    }
  }
}
