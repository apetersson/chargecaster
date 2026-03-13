import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Inject, Injectable, Logger } from "@nestjs/common";

import type { ConfigDocument } from "../config/schemas";
import { ConfigFileService } from "../config/config-file.service";
import { LoadForecastArtifactService, loadForecastManifestSchema } from "./load-forecast-artifact.service";
import { StorageService } from "../storage/storage.service";

const MIN_HISTORY_DAYS = 56;
const MIN_NEW_DAYS_SINCE_LAST_TRAINING = 14;
const TRAINING_WINDOW_START_HOUR = 1;
const TRAINING_WINDOW_END_HOUR = 5;

@Injectable()
export class ModelTrainingCoordinator {
  private readonly logger = new Logger(ModelTrainingCoordinator.name);
  private activeProcess: ChildProcessWithoutNullStreams | null = null;

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(LoadForecastArtifactService) private readonly artifactService: LoadForecastArtifactService,
    @Inject(ConfigFileService) private readonly configFileService: ConfigFileService,
  ) {}

  async maybeStartTraining(config: ConfigDocument): Promise<void> {
    if (!config.load_forecast?.self_training_enabled) {
      return;
    }
    if (this.activeProcess) {
      return;
    }
    const pythonExecutable = config.load_forecast.python_executable?.trim() || "python3";
    if (!isTrainingTimeWindow(new Date())) {
      return;
    }

    const totalHistoryDays = this.storage.listHistoryDayStatsBefore("9999-12-31").length;
    if (totalHistoryDays < MIN_HISTORY_DAYS) {
      return;
    }

    const artifact = this.artifactService.readActiveArtifact(config);
    if (artifact) {
      const lastTrainingEnd = artifact.manifest.training_window.end.slice(0, 10);
      const newHistoryDays = this.storage.listHistoryDayStatsBefore("9999-12-31")
        .filter((entry) => entry.date > lastTrainingEnd)
        .length;
      if (newHistoryDays < MIN_NEW_DAYS_SINCE_LAST_TRAINING) {
        return;
      }
    }

    const baseDir = this.artifactService.ensureBaseDir(config);
    const version = new Date().toISOString().replaceAll(":", "").replaceAll(".", "").replaceAll("-", "");
    const versionDir = join(baseDir, version);
    mkdirSync(versionDir, { recursive: true });

    const scriptPath = join(process.cwd(), "ml", "train_load_forecast.py");
    if (!existsSync(scriptPath)) {
      this.logger.warn(`Skipping self-training because ${scriptPath} is missing`);
      return;
    }

    const args = [
      scriptPath,
      "--config",
      this.configFileService.resolvePath(),
      "--db",
      join(process.cwd(), "..", "data", "db", "backend.sqlite"),
      "--output-dir",
      versionDir,
    ];
    this.logger.log(`Starting background load-forecast training in ${versionDir}`);
    const child = spawn(pythonExecutable, args, {
      cwd: process.cwd(),
      stdio: "pipe",
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
      },
    });
    this.activeProcess = child;
    child.stdout.on("data", (chunk) => this.logger.log(`[train] ${String(chunk).trimEnd()}`));
    child.stderr.on("data", (chunk) => this.logger.warn(`[train] ${String(chunk).trimEnd()}`));
    child.on("exit", (code) => {
      this.activeProcess = null;
      if (code !== 0) {
        this.logger.warn(`Background load-forecast training exited with code ${code}`);
        return;
      }
      this.promoteIfEligible(config, versionDir);
    });
  }

  isTrainingActive(): boolean {
    return this.activeProcess !== null;
  }

  private promoteIfEligible(config: ConfigDocument, versionDir: string): void {
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
        this.artifactService.promoteVersion(config, versionDir);
        this.artifactService.writePromotionMarker(versionDir);
        this.logger.log(`Promoted load-forecast model ${manifest.model_version}`);
        return;
      }
      this.logger.log(`Keeping existing load-forecast model; ${manifest.model_version} did not clear promotion gates`);
    } catch (error) {
      this.logger.warn(`Skipping model promotion for ${versionDir}: ${String(error)}`);
    }
  }

  listVersionDirs(config: ConfigDocument): string[] {
    const baseDir = this.artifactService.ensureBaseDir(config);
    return readdirSync(baseDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "current" && entry.name !== "current.next")
      .map((entry) => join(baseDir, entry.name))
      .sort();
  }
}

function isTrainingTimeWindow(now: Date): boolean {
  const hour = now.getHours();
  return hour >= TRAINING_WINDOW_START_HOUR && hour < TRAINING_WINDOW_END_HOUR;
}
