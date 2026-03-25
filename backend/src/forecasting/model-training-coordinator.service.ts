import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Inject, Injectable, Logger } from "@nestjs/common";

import type { ConfigDocument } from "../config/schemas";
import { ConfigFileService } from "../config/config-file.service";
import { isLoadForecastTrainingEnabled, isPriceForecastTrainingEnabled } from "../config/schemas";
import { StorageService } from "../storage/storage.service";
import { LoadForecastArtifactService, loadForecastManifestSchema } from "./load-forecast-artifact.service";
import { PriceForecastArtifactService, priceForecastManifestSchema } from "./price-forecast-artifact.service";
import { resolveBackendDbPath, resolveMlScriptPath } from "./model-paths";

const MIN_HISTORY_DAYS = 56;
const MIN_NEW_DAYS_SINCE_LAST_TRAINING = 14;
const TRAINING_WINDOW_START_HOUR = 1;
const TRAINING_WINDOW_END_HOUR = 5;
const PYTHON_EXECUTABLE = "python3";

type TrainingJobKey = "load-forecast" | "price-forecast";

interface TrainingJob {
  key: TrainingJobKey;
  label: string;
  versionDir: string;
  args: string[];
  promoteIfEligible: () => void;
}

@Injectable()
export class ModelTrainingCoordinator {
  private readonly logger = new Logger(ModelTrainingCoordinator.name);
  private activeProcess: ChildProcessWithoutNullStreams | null = null;
  private pendingConfig: ConfigDocument | null = null;
  private readonly reportedBlockingJobs = new Set<TrainingJobKey>();

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(LoadForecastArtifactService) private readonly loadArtifactService: LoadForecastArtifactService,
    @Inject(PriceForecastArtifactService) private readonly priceArtifactService: PriceForecastArtifactService,
    @Inject(ConfigFileService) private readonly configFileService: ConfigFileService,
  ) {}

  maybeStartTraining(config: ConfigDocument): void {
    this.pendingConfig = config;
    if (this.activeProcess) {
      return;
    }

    const job = this.resolveNextJob(config, new Date());
    if (!job) {
      return;
    }

    this.logger.log(`Starting background ${job.label} training in ${job.versionDir}`);
    const child = spawn(PYTHON_EXECUTABLE, job.args, {
      cwd: process.cwd(),
      stdio: "pipe",
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
    });
    this.activeProcess = child;
    child.stdout.on("data", (chunk) => this.logger.log(`[train:${job.key}] ${String(chunk).trimEnd()}`));
    child.stderr.on("data", (chunk) => this.logger.warn(`[train:${job.key}] ${String(chunk).trimEnd()}`));
    child.on("exit", (code) => {
      this.activeProcess = null;
      if (code !== 0) {
        this.logger.warn(`Background ${job.label} training exited with code ${code}; will retry on the next scheduler-triggered training check`);
        return;
      }
      job.promoteIfEligible();
      const nextConfig = this.pendingConfig;
      if (nextConfig) {
        this.maybeStartTraining(nextConfig);
      }
    });
  }

  isTrainingActive(): boolean {
    return this.activeProcess !== null;
  }

  listVersionDirs(config: ConfigDocument): string[] {
    const baseDirs = [
      this.loadArtifactService.ensureBaseDir(config),
      this.priceArtifactService.ensureBaseDir(config),
    ];
    return baseDirs.flatMap((baseDir) => readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "current" && entry.name !== "current.next")
      .map((entry) => join(baseDir, entry.name)))
      .sort();
  }

  private resolveNextJob(config: ConfigDocument, now: Date): TrainingJob | null {
    const totalHistoryDays = this.storage.listHistoryDayStatsBefore("9999-12-31").length;
    if (totalHistoryDays <= 0) {
      return null;
    }

    const loadMissing = isLoadForecastTrainingEnabled(config) && !this.loadArtifactService.readActiveArtifact(config);
    const priceMissing = isPriceForecastTrainingEnabled(config) && !this.priceArtifactService.readActiveArtifact(config);
    const startupBootstrapMode = Boolean(loadMissing || priceMissing);

    const loadJob = this.buildLoadForecastJob(config, now, totalHistoryDays, startupBootstrapMode);
    if (loadJob) {
      return loadJob;
    }

    const priceJob = this.buildPriceForecastJob(config, now, totalHistoryDays, startupBootstrapMode);
    if (priceJob) {
      return priceJob;
    }

    return null;
  }

  private buildLoadForecastJob(
    config: ConfigDocument,
    now: Date,
    totalHistoryDays: number,
    startupBootstrapMode: boolean,
  ): TrainingJob | null {
    if (!isLoadForecastTrainingEnabled(config)) {
      return null;
    }
    const artifact = this.loadArtifactService.readActiveArtifact(config);
    if (!this.shouldTrainArtifact(artifact?.manifest.training_window.end ?? null, totalHistoryDays, now, startupBootstrapMode)) {
      return null;
    }

    const scriptPath = resolveMlScriptPath("train_load_forecast.py");
    const prerequisiteError = this.resolveTrainingPrerequisiteError(scriptPath);
    if (prerequisiteError) {
      this.reportBlockedTrainingJob("load-forecast", prerequisiteError, scriptPath, !artifact);
      return null;
    }
    this.reportedBlockingJobs.delete("load-forecast");

    const versionDir = this.createVersionDir(this.loadArtifactService.ensureBaseDir(config));
    return {
      key: "load-forecast",
      label: "load-forecast",
      versionDir,
      args: [
        scriptPath,
        "--config",
        this.configFileService.resolvePath(),
        "--db",
        resolveBackendDbPath(),
        "--output-dir",
        versionDir,
      ],
      promoteIfEligible: () => this.promoteLoadForecastIfEligible(config, versionDir),
    };
  }

  private buildPriceForecastJob(
    config: ConfigDocument,
    now: Date,
    totalHistoryDays: number,
    startupBootstrapMode: boolean,
  ): TrainingJob | null {
    if (!isPriceForecastTrainingEnabled(config)) {
      return null;
    }
    const artifact = this.priceArtifactService.readActiveArtifact(config);
    if (!this.shouldTrainArtifact(artifact?.manifest.training_window.end ?? null, totalHistoryDays, now, startupBootstrapMode)) {
      return null;
    }

    const scriptPath = resolveMlScriptPath("train_price_forecast.py");
    const prerequisiteError = this.resolveTrainingPrerequisiteError(scriptPath);
    if (prerequisiteError) {
      this.reportBlockedTrainingJob("price-forecast", prerequisiteError, scriptPath, !artifact);
      return null;
    }
    this.reportedBlockingJobs.delete("price-forecast");

    const versionDir = this.createVersionDir(this.priceArtifactService.ensureBaseDir(config));
    return {
      key: "price-forecast",
      label: "price-forecast",
      versionDir,
      args: [
        scriptPath,
        "--config",
        this.configFileService.resolvePath(),
        "--db",
        resolveBackendDbPath(),
        "--output-dir",
        versionDir,
      ],
      promoteIfEligible: () => this.promotePriceForecastIfEligible(config, versionDir),
    };
  }

  private shouldTrainArtifact(
    lastTrainingEnd: string | null,
    totalHistoryDays: number,
    now: Date,
    startupBootstrapMode: boolean,
  ): boolean {
    if (startupBootstrapMode && !lastTrainingEnd) {
      return totalHistoryDays > 0;
    }
    if (!isTrainingTimeWindow(now)) {
      return false;
    }
    if (totalHistoryDays < MIN_HISTORY_DAYS) {
      return false;
    }
    if (!lastTrainingEnd) {
      return true;
    }
    const lastTrainingDate = lastTrainingEnd.slice(0, 10);
    const newHistoryDays = this.storage.listHistoryDayStatsBefore("9999-12-31")
      .filter((entry) => entry.date > lastTrainingDate)
      .length;
    return newHistoryDays >= MIN_NEW_DAYS_SINCE_LAST_TRAINING;
  }

  private createVersionDir(baseDir: string): string {
    const version = new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replaceAll("-", "");
    const versionDir = join(baseDir, version);
    mkdirSync(versionDir, { recursive: true });
    return versionDir;
  }

  private promoteLoadForecastIfEligible(config: ConfigDocument, versionDir: string): void {
    const manifestPath = join(versionDir, "manifest.json");
    const metricsPath = join(versionDir, "metrics.json");
    if (!existsSync(manifestPath) || !existsSync(metricsPath)) {
      this.logger.warn(`Skipping promotion for ${versionDir}: manifest or metrics missing`);
      return;
    }

    try {
      const manifest = loadForecastManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf-8")));
      const metrics = JSON.parse(readFileSync(metricsPath, "utf-8")) as {
        model?: { mae?: number; p90_economic_hours_absolute_error?: number };
        active_model?: { mae?: number; p90_economic_hours_absolute_error?: number };
      };
      const modelMae = Number(metrics.model?.mae ?? Number.NaN);
      const activeMae = Number(metrics.active_model?.mae ?? Number.NaN);
      const modelEconomicP90 = Number(metrics.model?.p90_economic_hours_absolute_error ?? Number.NaN);
      const activeEconomicP90 = Number(metrics.active_model?.p90_economic_hours_absolute_error ?? Number.NaN);
      const improvementRatio = Number.isFinite(activeMae) && activeMae > 0
        ? (activeMae - modelMae) / activeMae
        : Number.POSITIVE_INFINITY;
      const p90Pass = !Number.isFinite(activeEconomicP90) || !Number.isFinite(modelEconomicP90) || modelEconomicP90 <= activeEconomicP90;
      if (improvementRatio >= 0.03 && p90Pass) {
        this.loadArtifactService.promoteVersion(config, versionDir);
        this.loadArtifactService.writePromotionMarker(versionDir);
        this.logger.log(`Promoted load-forecast model ${manifest.model_version}`);
        return;
      }
      this.logger.log(`Keeping existing load-forecast model; ${manifest.model_version} did not clear promotion gates`);
    } catch (error) {
      this.logger.warn(`Skipping model promotion for ${versionDir}: ${String(error)}`);
    }
  }

  private promotePriceForecastIfEligible(config: ConfigDocument, versionDir: string): void {
    const manifestPath = join(versionDir, "manifest.json");
    const metricsPath = join(versionDir, "metrics.json");
    if (!existsSync(manifestPath) || !existsSync(metricsPath)) {
      this.logger.warn(`Skipping promotion for ${versionDir}: manifest or metrics missing`);
      return;
    }

    try {
      const manifest = priceForecastManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf-8")));
      const metrics = JSON.parse(readFileSync(metricsPath, "utf-8")) as {
        model?: { mae?: number };
        active_model?: { mae?: number };
      };
      const modelMae = Number(metrics.model?.mae ?? Number.NaN);
      const activeMae = Number(metrics.active_model?.mae ?? Number.NaN);
      const improvementRatio = Number.isFinite(activeMae) && activeMae > 0
        ? (activeMae - modelMae) / activeMae
        : Number.POSITIVE_INFINITY;
      if (improvementRatio >= 0.03) {
        this.priceArtifactService.promoteVersion(config, versionDir);
        this.priceArtifactService.writePromotionMarker(versionDir);
        this.logger.log(`Promoted price-forecast model ${manifest.model_version}`);
        return;
      }
      this.logger.log(`Keeping existing price-forecast model; ${manifest.model_version} did not clear promotion gates`);
    } catch (error) {
      this.logger.warn(`Skipping model promotion for ${versionDir}: ${String(error)}`);
    }
  }

  private resolveTrainingPrerequisiteError(scriptPath: string): string | null {
    if (!existsSync(scriptPath)) {
      return `training script missing at ${scriptPath}`;
    }
    const probe = spawnSync(PYTHON_EXECUTABLE, ["--version"], { stdio: "ignore" });
    if (probe.error) {
      return `${PYTHON_EXECUTABLE} is not available (${probe.error.message})`;
    }
    if ((probe.status ?? 1) !== 0) {
      return `${PYTHON_EXECUTABLE} exited with status ${probe.status ?? "unknown"} during startup probe`;
    }
    return null;
  }

  private reportBlockedTrainingJob(
    key: TrainingJobKey,
    prerequisiteError: string,
    scriptPath: string,
    artifactMissing: boolean,
  ): void {
    if (this.reportedBlockingJobs.has(key)) {
      return;
    }
    this.reportedBlockingJobs.add(key);
    const phase = artifactMissing ? "bootstrap" : "retraining";
    this.logger.error(
      `Cannot start ${phase} for ${key}: ${prerequisiteError}. `
      + `This runtime needs ${PYTHON_EXECUTABLE} and the training scripts mounted into the image. `
      + `Expected script path: ${scriptPath}`,
    );
  }
}

function isTrainingTimeWindow(now: Date): boolean {
  const hour = now.getHours();
  return hour >= TRAINING_WINDOW_START_HOUR && hour < TRAINING_WINDOW_END_HOUR;
}
