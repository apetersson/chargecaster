import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";

import { SimulationService } from "../simulation/simulation.service";
import { FroniusService } from "../fronius/fronius.service";
import type { ConfigDocument } from "./schemas";
import { SimulationPreparationService } from "./simulation-preparation.service";
import { RuntimeConfigService } from "./runtime-config.service";

@Injectable()
export class SimulationSeedService implements OnModuleDestroy {
  private readonly logger = new Logger(SimulationSeedService.name);
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private runInProgress = false;
  private nextIntervalSeconds: number | null = null;

  constructor(
    @Inject(RuntimeConfigService) private readonly configState: RuntimeConfigService,
    @Inject(SimulationPreparationService) private readonly preparationService: SimulationPreparationService,
    @Inject(SimulationService) private readonly simulationService: SimulationService,
    @Inject(FroniusService) private readonly froniusService: FroniusService,
  ) {
  }

  async seedFromConfig(): Promise<void> {
    if (this.runInProgress) {
      this.logger.warn("Simulation already running; skipping new request.");
      return;
    }
    this.runInProgress = true;
    try {
      const rawConfig = this.configState.getDocument();
      this.logger.verbose("Loaded configuration from runtime state.");

      const prepared = await this.preparationService.prepare(rawConfig);
      this.nextIntervalSeconds = prepared.intervalSeconds;

      if (!prepared.forecast.length) {
        const message = "No forecast data could be obtained from configured sources.";
        this.logger.error(message);
        throw new Error(message);
      }

      this.logger.log(
        `Running simulation with ${prepared.forecast.length} forecast slots; live SOC: ${
          prepared.liveState.battery_soc ?? "n/a"
        }`,
      );

      const snapshot = this.simulationService.runSimulation({
        config: prepared.simulationConfig,
        liveState: prepared.liveState,
        forecast: prepared.forecast,
        solarForecast: prepared.solarForecast,
        forecastEras: prepared.forecastEras,
        warnings: prepared.warnings,
        errors: prepared.errors,
        priceSnapshotEurPerKwh: prepared.priceSnapshot,
        observations: {
          gridPowerW: prepared.liveGridPowerW,
          solarPowerW: prepared.liveSolarPowerW,
          homePowerW: prepared.liveHomePowerW,
        },
      });
      this.logger.log("Seeded snapshot using config data.");
      await this.applyFronius(snapshot, rawConfig);
    } catch (error) {
      this.logger.error(`Simulation seed failed: ${this.describeError(error)}`);
      throw error;
    } finally {
      this.runInProgress = false;
      this.scheduleNextRun();
    }
  }

  onModuleDestroy(): void {
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  private async applyFronius(snapshot: Awaited<ReturnType<SimulationService["runSimulation"]>>, config: ConfigDocument): Promise<void> {
    try {
      const result = await this.froniusService.applyOptimization(config, snapshot);
      if (result.errorMessage) {
        this.logger.warn(`Snapshot flagged with error: ${result.errorMessage}`);
        this.simulationService.appendErrorsToLatestSnapshot([result.errorMessage]);
      }
    } catch (error) {
      this.logger.warn(`Fronius integration failed: ${this.describeError(error)}`);
    }
  }

  private scheduleNextRun(): void {
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
    const intervalSeconds = this.nextIntervalSeconds ?? 300;
    const delayMs = Math.max(1, intervalSeconds) * 1000;
    this.schedulerTimer = setTimeout(() => {
      this.seedFromConfig().catch((error) => this.logger.error(`Scheduled run failed: ${this.describeError(error)}`));
    }, delayMs);
    this.logger.log(`Next simulation scheduled in ${(delayMs / 60000).toFixed(2)} minutes`);
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
