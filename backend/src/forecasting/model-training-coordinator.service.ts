import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Inject, Injectable, Logger } from "@nestjs/common";

import type { ConfigDocument } from "../config/schemas";
import { ConfigFileService } from "../config/config-file.service";
import {
  isLoadForecastTrainingEnabled,
  isPriceForecastTrainingEnabled,
  resolveLoadForecastAutoPromoteMode,
  resolveLoadForecastMinHistoryDays,
  resolveLoadForecastMinNewHistoryDays,
  resolveLoadForecastPythonExecutable,
  resolveLoadForecastRetrainWindow,
} from "../config/schemas";
import { StorageService } from "../storage/storage.service";
import { LoadForecastArtifactService, loadForecastManifestSchema } from "./load-forecast-artifact.service";
import { evaluateAndPersistLoadForecastReplay } from "./load-forecast-replay";
import { PriceForecastArtifactService, priceForecastManifestSchema } from "./price-forecast-artifact.service";
import { resolveBackendDbPath, resolveMlScriptPath } from "./model-paths";

const REQUIRED_PYTHON_MODULES = ["catboost"] as const;

type TrainingJobKey = "load-forecast" | "price-forecast";

interface TrainingJob {
  key: TrainingJobKey;
  label: string;
  versionDir: string;
  pythonExecutable: string;
  args: string[];
  promoteIfEligible: () => void;
}

interface TrainingJobRuntimeStatus {
  lastTrainingAttemptAt: string | null;
  lastTrainingResult: string | null;
  lastTrainingMessage: string | null;
  lastPromotionDecision: string | null;
}

@Injectable()
export class ModelTrainingCoordinator {
  private readonly logger = new Logger(ModelTrainingCoordinator.name);
  private activeProcess: ChildProcessWithoutNullStreams | null = null;
  private activeJobKey: TrainingJobKey | null = null;
  private pendingConfig: ConfigDocument | null = null;
  private readonly reportedBlockingJobs = new Set<TrainingJobKey>();
  private readonly jobStatus = new Map<TrainingJobKey, TrainingJobRuntimeStatus>();

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
    this.setJobStatus(job.key, {
      lastTrainingAttemptAt: new Date().toISOString(),
      lastTrainingResult: "started",
      lastTrainingMessage: `Training candidate ${job.versionDir}`,
    });
    const child = spawn(job.pythonExecutable, job.args, {
      cwd: process.cwd(),
      stdio: "pipe",
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
    });
    this.activeProcess = child;
    this.activeJobKey = job.key;
    child.stdout.on("data", (chunk) => this.logger.log(`[train:${job.key}] ${String(chunk).trimEnd()}`));
    child.stderr.on("data", (chunk) => this.logger.warn(`[train:${job.key}] ${String(chunk).trimEnd()}`));
    child.on("exit", (code) => {
      this.activeProcess = null;
      this.activeJobKey = null;
      if (code !== 0) {
        this.setJobStatus(job.key, {
          lastTrainingResult: "failed",
          lastTrainingMessage: `Training exited with code ${code ?? "unknown"}`,
          lastPromotionDecision: "candidate_not_promoted",
        });
        this.logger.warn(`Background ${job.label} training exited with code ${code}; will retry on the next scheduler-triggered training check`);
        return;
      }
      void Promise.resolve(job.promoteIfEligible()).finally(() => {
        const nextConfig = this.pendingConfig;
        if (nextConfig) {
          this.maybeStartTraining(nextConfig);
        }
      });
    });
  }

  isTrainingActive(): boolean {
    return this.activeProcess !== null;
  }

  getJobStatus(key: TrainingJobKey): TrainingJobRuntimeStatus & { trainingActive: boolean } {
    const current = this.jobStatus.get(key) ?? {
      lastTrainingAttemptAt: null,
      lastTrainingResult: null,
      lastTrainingMessage: null,
      lastPromotionDecision: null,
    };
    return {
      ...current,
      trainingActive: this.activeJobKey === key,
    };
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
    if (!this.shouldTrainArtifact(config, artifact?.manifest.training_window.end ?? null, totalHistoryDays, now, startupBootstrapMode)) {
      return null;
    }

    const scriptPath = resolveMlScriptPath("train_load_forecast.py");
    const pythonExecutable = resolveLoadForecastPythonExecutable(config);
    const prerequisiteError = this.resolveTrainingPrerequisiteError(pythonExecutable, scriptPath);
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
      pythonExecutable,
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
    if (!this.shouldTrainArtifact(config, artifact?.manifest.training_window.end ?? null, totalHistoryDays, now, startupBootstrapMode)) {
      return null;
    }

    const scriptPath = resolveMlScriptPath("train_price_forecast.py");
    const pythonExecutable = resolveLoadForecastPythonExecutable(config);
    const prerequisiteError = this.resolveTrainingPrerequisiteError(pythonExecutable, scriptPath);
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
      pythonExecutable,
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
    config: ConfigDocument,
    lastTrainingEnd: string | null,
    totalHistoryDays: number,
    now: Date,
    startupBootstrapMode: boolean,
  ): boolean {
    if (startupBootstrapMode && !lastTrainingEnd) {
      return totalHistoryDays > 0;
    }
    if (!isTrainingTimeWindow(now, resolveLoadForecastRetrainWindow(config))) {
      return false;
    }
    if (totalHistoryDays < resolveLoadForecastMinHistoryDays(config)) {
      return false;
    }
    if (!lastTrainingEnd) {
      return true;
    }
    const lastTrainingDate = lastTrainingEnd.slice(0, 10);
    const newHistoryDays = this.storage.listHistoryDayStatsBefore("9999-12-31")
      .filter((entry) => entry.date > lastTrainingDate)
      .length;
    return newHistoryDays >= resolveLoadForecastMinNewHistoryDays(config);
  }

  private createVersionDir(baseDir: string): string {
    const version = new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replaceAll("-", "");
    const versionDir = join(baseDir, version);
    mkdirSync(versionDir, { recursive: true });
    return versionDir;
  }

  private async promoteLoadForecastIfEligible(config: ConfigDocument, versionDir: string): Promise<void> {
    const manifestPath = join(versionDir, "manifest.json");
    const metricsPath = join(versionDir, "metrics.json");
    if (!existsSync(manifestPath) || !existsSync(metricsPath)) {
      this.setJobStatus("load-forecast", {
        lastTrainingResult: "failed",
        lastTrainingMessage: "manifest or metrics missing after training",
        lastPromotionDecision: "candidate_not_promoted",
      });
      this.logger.warn(`Skipping promotion for ${versionDir}: manifest or metrics missing`);
      return;
    }

    try {
      await evaluateAndPersistLoadForecastReplay({
        config,
        storage: this.storage,
        versionDir,
      });
      const manifest = loadForecastManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf-8")));
      const metrics = JSON.parse(readFileSync(metricsPath, "utf-8")) as {
        model?: { mae?: number; p90_economic_hours_absolute_error?: number };
        hybrid?: { mae?: number; p90_economic_hours_absolute_error?: number };
        active_model?: { mae?: number; p90_economic_hours_absolute_error?: number };
        replay?: { cost_delta_eur?: number };
      };
      if (resolveLoadForecastAutoPromoteMode(config) === "manual") {
        this.loadArtifactService.updatePromotionDecision(versionDir, "candidate_ready_manual");
        this.setJobStatus("load-forecast", {
          lastTrainingResult: "candidate_ready",
          lastTrainingMessage: `Candidate ${manifest.model_version} trained; manual promotion required`,
          lastPromotionDecision: "candidate_not_promoted",
        });
        return;
      }
      const modelMae = Number(metrics.model?.mae ?? Number.NaN);
      const activeMae = Number(metrics.active_model?.mae ?? Number.NaN);
      const modelEconomicP90 = Number(metrics.model?.p90_economic_hours_absolute_error ?? Number.NaN);
      const activeEconomicP90 = Number(metrics.active_model?.p90_economic_hours_absolute_error ?? Number.NaN);
      const hybridMae = Number(metrics.hybrid?.mae ?? Number.NaN);
      const hybridEconomicP90 = Number(metrics.hybrid?.p90_economic_hours_absolute_error ?? Number.NaN);
      const replayCostDelta = Number(metrics.replay?.cost_delta_eur ?? Number.NaN);
      const improvementRatio = Number.isFinite(activeMae) && activeMae > 0
        ? (activeMae - modelMae) / activeMae
        : Number.POSITIVE_INFINITY;
      const p90Pass = !Number.isFinite(activeEconomicP90) || !Number.isFinite(modelEconomicP90) || modelEconomicP90 <= activeEconomicP90;
      const hybridPass = (!Number.isFinite(hybridMae) || modelMae <= hybridMae)
        && (!Number.isFinite(hybridEconomicP90) || !Number.isFinite(modelEconomicP90) || modelEconomicP90 <= hybridEconomicP90);
      const replayPass = Number.isFinite(replayCostDelta) && replayCostDelta <= 0;
      if (improvementRatio >= 0.03 && p90Pass && hybridPass && replayPass) {
        this.loadArtifactService.updatePromotionDecision(versionDir, "promoted");
        this.loadArtifactService.promoteVersion(config, versionDir);
        this.loadArtifactService.writePromotionMarker(versionDir);
        this.setJobStatus("load-forecast", {
          lastTrainingResult: "promoted",
          lastTrainingMessage: `Promoted ${manifest.model_version}`,
          lastPromotionDecision: "promoted",
        });
        this.logger.log(`Promoted load-forecast model ${manifest.model_version}`);
        return;
      }
      this.loadArtifactService.updatePromotionDecision(versionDir, "candidate_not_promoted");
      this.setJobStatus("load-forecast", {
        lastTrainingResult: "rejected",
        lastTrainingMessage: `Candidate ${manifest.model_version} did not clear strict promotion gates`,
        lastPromotionDecision: "candidate_not_promoted",
      });
      this.logger.log(`Keeping existing load-forecast model; ${manifest.model_version} did not clear promotion gates`);
    } catch (error) {
      try {
        this.loadArtifactService.updatePromotionDecision(versionDir, "evaluation_failed");
      } catch {
        // Ignore secondary manifest write failures while surfacing the primary error.
      }
      this.setJobStatus("load-forecast", {
        lastTrainingResult: "failed",
        lastTrainingMessage: `Promotion failed: ${String(error)}`,
        lastPromotionDecision: "candidate_not_promoted",
      });
      this.logger.warn(`Skipping model promotion for ${versionDir}: ${String(error)}`);
    }
  }

  private promotePriceForecastIfEligible(config: ConfigDocument, versionDir: string): void {
    const manifestPath = join(versionDir, "manifest.json");
    const metricsPath = join(versionDir, "metrics.json");
    if (!existsSync(manifestPath) || !existsSync(metricsPath)) {
      this.setJobStatus("price-forecast", {
        lastTrainingResult: "failed",
        lastTrainingMessage: "manifest or metrics missing after training",
        lastPromotionDecision: "candidate_not_promoted",
      });
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
        this.setJobStatus("price-forecast", {
          lastTrainingResult: "promoted",
          lastTrainingMessage: `Promoted ${manifest.model_version}`,
          lastPromotionDecision: "promoted",
        });
        this.logger.log(`Promoted price-forecast model ${manifest.model_version}`);
        return;
      }
      this.setJobStatus("price-forecast", {
        lastTrainingResult: "rejected",
        lastTrainingMessage: `Candidate ${manifest.model_version} did not clear promotion gates`,
        lastPromotionDecision: "candidate_not_promoted",
      });
      this.logger.log(`Keeping existing price-forecast model; ${manifest.model_version} did not clear promotion gates`);
    } catch (error) {
      this.setJobStatus("price-forecast", {
        lastTrainingResult: "failed",
        lastTrainingMessage: `Promotion failed: ${String(error)}`,
        lastPromotionDecision: "candidate_not_promoted",
      });
      this.logger.warn(`Skipping model promotion for ${versionDir}: ${String(error)}`);
    }
  }

  private resolveTrainingPrerequisiteError(pythonExecutable: string, scriptPath: string): string | null {
    if (!existsSync(scriptPath)) {
      return `training script missing at ${scriptPath}`;
    }
    const probe = spawnSync(pythonExecutable, ["--version"], { stdio: "ignore" });
    if (probe.error) {
      return `${pythonExecutable} is not available (${probe.error.message})`;
    }
    if ((probe.status ?? 1) !== 0) {
      return `${pythonExecutable} exited with status ${probe.status ?? "unknown"} during startup probe`;
    }
    for (const moduleName of REQUIRED_PYTHON_MODULES) {
      const importProbe = spawnSync(pythonExecutable, ["-c", `import ${moduleName}`], { stdio: "ignore" });
      if (importProbe.error) {
        return `unable to verify Python module '${moduleName}' (${importProbe.error.message})`;
      }
      if ((importProbe.status ?? 1) !== 0) {
        return `Python module '${moduleName}' is missing; install backend/ml/requirements.txt into ${pythonExecutable}`;
      }
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
      + "This runtime needs the configured Python executable and the training scripts mounted into the image. "
      + `Expected script path: ${scriptPath}`,
    );
    this.setJobStatus(key, {
      lastTrainingResult: "blocked",
      lastTrainingMessage: prerequisiteError,
      lastPromotionDecision: "candidate_not_promoted",
    });
  }

  private setJobStatus(key: TrainingJobKey, next: Partial<TrainingJobRuntimeStatus>): void {
    const current = this.jobStatus.get(key) ?? {
      lastTrainingAttemptAt: null,
      lastTrainingResult: null,
      lastTrainingMessage: null,
      lastPromotionDecision: null,
    };
    this.jobStatus.set(key, {
      ...current,
      ...next,
    });
  }
}

function isTrainingTimeWindow(now: Date, window: { startHour: number; endHour: number }): boolean {
  const hour = now.getHours();
  return hour >= window.startHour && hour < window.endHour;
}
