import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";

import type { ConfigDocument } from "../config/schemas";
import { LOAD_FORECAST_FEATURE_COUNT, LOAD_FORECAST_FEATURE_NAMES, LOAD_FORECAST_FEATURE_SCHEMA_VERSION } from "./load-forecast-feature-contract";
import { resolveBundledLoadForecastCurrentDir, resolveLoadForecastBaseDir } from "./model-paths";

const BUNDLED_SEEDED_MARKER = ".bundled-seeded";

const forwardFeatureCoverageSchema = z.object({
  history_forecast_solar_ratio: z.number().min(0).max(1),
  solar_proxy_ratio: z.number().min(0).max(1),
  realized_solar_fallback_ratio: z.number().min(0).max(1),
});

const replayMetricsSchema = z.object({
  cost_delta_eur: z.number().optional(),
  mae: z.number().optional(),
  p90_economic_hours_absolute_error: z.number().optional(),
  mode_switch_count: z.number().optional(),
  mode_switch_delta: z.number().optional(),
}).partial();

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
  feature_count: z.number().int().positive(),
  feature_names: z.array(z.string()),
  target_mode: z.enum(["absolute_house_power_v1", "baseline_delta_v1", "baseline_ratio_v1"]).optional(),
  trained_at: z.string(),
  training_window: trainingWindowSchema,
  history_row_count: z.number().int().nonnegative(),
  hourly_row_count: z.number().int().nonnegative(),
  metrics_summary: metricsSummarySchema,
  training_data_summary: z.object({
    forward_feature_coverage: forwardFeatureCoverageSchema,
  }).optional(),
  walk_forward_metrics: z.record(z.string(), z.number()).optional(),
  replay_metrics: replayMetricsSchema.optional(),
  promotion_decision: z.string().optional(),
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
  activeSource: "runtime_current" | "bundled_seeded";
  manifest: LoadForecastManifest;
}

export type LoadForecastArtifactInspectionReason =
  | "ok"
  | "no_artifact"
  | "schema_mismatch"
  | "invalid_manifest";

export interface LoadForecastArtifactInspection {
  artifact: ActiveLoadForecastArtifact | null;
  reason: LoadForecastArtifactInspectionReason;
  detail?: string;
}

@Injectable()
export class LoadForecastArtifactService {
  private readonly logger = new Logger(LoadForecastArtifactService.name);

  resolveBaseDir(config: ConfigDocument): string {
    return resolveLoadForecastBaseDir(config);
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
    return this.inspectActiveArtifact(config).artifact;
  }

  inspectActiveArtifact(config: ConfigDocument): LoadForecastArtifactInspection {
    this.seedBundledStarterArtifact(config);
    return this.inspectArtifactDir(this.resolveCurrentDir(config), this.resolveBaseDir(config));
  }

  inspectVersionArtifact(config: ConfigDocument, versionDir: string): LoadForecastArtifactInspection {
    return this.inspectArtifactDir(versionDir, this.resolveBaseDir(config));
  }

  updateReplayMetrics(
    versionDir: string,
    replayMetrics: z.infer<typeof replayMetricsSchema> & { window_count?: number },
  ): void {
    const manifestPath = join(versionDir, "manifest.json");
    const metricsPath = join(versionDir, "metrics.json");
    if (!existsSync(manifestPath) || !existsSync(metricsPath)) {
      throw new Error(`Cannot update replay metrics for ${versionDir}: manifest or metrics missing`);
    }

    const manifest = loadForecastManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf-8")));
    const metrics = JSON.parse(readFileSync(metricsPath, "utf-8")) as Record<string, unknown>;
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        replay_metrics: replayMetrics,
      }, null, 2),
      "utf-8",
    );
    writeFileSync(
      metricsPath,
      JSON.stringify({
        ...metrics,
        replay: replayMetrics,
      }, null, 2),
      "utf-8",
    );
  }

  updatePromotionDecision(versionDir: string, promotionDecision: string): void {
    const manifestPath = join(versionDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      throw new Error(`Cannot update promotion decision for ${versionDir}: manifest missing`);
    }
    const manifest = loadForecastManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf-8")));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        ...manifest,
        promotion_decision: promotionDecision,
      }, null, 2),
      "utf-8",
    );
  }

  private inspectArtifactDir(artifactDir: string, baseDir: string): LoadForecastArtifactInspection {
    const currentDir = artifactDir;
    const manifestPath = join(currentDir, "manifest.json");
    const modelPath = join(currentDir, "model.cbm");
    const metricsPath = join(currentDir, "metrics.json");
    const trainingLogPath = join(currentDir, "training.log");

    if (!existsSync(currentDir) || !existsSync(manifestPath) || !existsSync(modelPath)) {
      return { artifact: null, reason: "no_artifact" };
    }

    try {
      const manifest = loadForecastManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf-8")));
      if (manifest.feature_schema_version !== LOAD_FORECAST_FEATURE_SCHEMA_VERSION) {
        this.logger.warn(
          `Ignoring load-forecast artifact ${manifest.model_version}: schema ${manifest.feature_schema_version} != ${LOAD_FORECAST_FEATURE_SCHEMA_VERSION}`,
        );
        return { artifact: null, reason: "schema_mismatch", detail: manifest.feature_schema_version };
      }
      if (manifest.feature_count !== LOAD_FORECAST_FEATURE_COUNT) {
        this.logger.warn(
          `Ignoring load-forecast artifact ${manifest.model_version}: feature_count ${manifest.feature_count} != ${LOAD_FORECAST_FEATURE_COUNT}`,
        );
        return { artifact: null, reason: "invalid_manifest", detail: "feature_count_mismatch" };
      }
      if (manifest.feature_names.join("|") !== LOAD_FORECAST_FEATURE_NAMES.join("|")) {
        this.logger.warn(`Ignoring load-forecast artifact ${manifest.model_version}: feature_names do not match runtime contract`);
        return { artifact: null, reason: "invalid_manifest", detail: "feature_names_mismatch" };
      }
      return { artifact: {
        baseDir,
        currentDir,
        modelPath,
        manifestPath,
        metricsPath,
        trainingLogPath,
        activeSource: existsSync(join(currentDir, BUNDLED_SEEDED_MARKER)) ? "bundled_seeded" : "runtime_current",
        manifest,
      }, reason: "ok" };
    } catch (error) {
      this.logger.warn(`Ignoring invalid load-forecast artifact in ${currentDir}: ${String(error)}`);
      return { artifact: null, reason: "invalid_manifest", detail: String(error) };
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
      if (manifest.feature_count !== LOAD_FORECAST_FEATURE_COUNT || manifest.feature_names.join("|") !== LOAD_FORECAST_FEATURE_NAMES.join("|")) {
        this.logger.warn(`Ignoring bundled load-forecast artifact ${manifest.model_version}: feature contract mismatch`);
        return;
      }
      const baseDir = this.ensureBaseDir(config);
      const nextDir = join(baseDir, "current.next");
      rmSync(nextDir, { recursive: true, force: true });
      cpSync(bundledCurrentDir, nextDir, { recursive: true });
      writeFileSync(join(nextDir, BUNDLED_SEEDED_MARKER), new Date().toISOString(), "utf-8");
      rmSync(currentDir, { recursive: true, force: true });
      renameSync(nextDir, currentDir);
      this.logger.log(`Seeded bundled load-forecast starter model ${manifest.model_version} into ${currentDir}`);
    } catch (error) {
      this.logger.warn(`Failed to seed bundled load-forecast starter artifact from ${bundledCurrentDir}: ${String(error)}`);
    }
  }
}
