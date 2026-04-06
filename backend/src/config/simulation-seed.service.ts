import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";

import { describeError } from "@chargecaster/domain";
import { SimulationService } from "../simulation/simulation.service";
import { OptimisationCommandTranslator } from "../hardware/optimisation-command-translator.service";
import { BATTERY_CONTROL_BACKEND } from "../hardware/battery-control-backend";
import type { BatteryControlBackend } from "../hardware/battery-control-backend";
import { ModelTrainingCoordinator } from "../forecasting/model-training-coordinator.service";
import { SimulationPreparationService } from "./simulation-preparation.service";
import { DynamicPriceConfigService } from "./dynamic-price-config.service";
import { RuntimeConfigService } from "./runtime-config.service";

@Injectable()
export class SimulationSeedService implements OnModuleDestroy {
  private readonly logger = new Logger(SimulationSeedService.name);
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private runInProgress = false;
  private nextIntervalSeconds: number | null = null;

  constructor(
    @Inject(RuntimeConfigService) private readonly configState: RuntimeConfigService,
    @Inject(DynamicPriceConfigService) private readonly dynamicPriceConfigService: DynamicPriceConfigService,
    @Inject(SimulationPreparationService) private readonly preparationService: SimulationPreparationService,
    @Inject(SimulationService) private readonly simulationService: SimulationService,
    @Inject(BATTERY_CONTROL_BACKEND) private readonly batteryControlBackend: BatteryControlBackend,
    @Inject(OptimisationCommandTranslator) private readonly optimisationCommandTranslator: OptimisationCommandTranslator,
    @Inject(ModelTrainingCoordinator) private readonly modelTrainingCoordinator: ModelTrainingCoordinator,
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
      const effectiveConfig = await this.dynamicPriceConfigService.refreshAndApply(rawConfig);

      const prepared = await this.preparationService.prepare(effectiveConfig);
      const feedInTariffEurPerKwhBySlot = await this.dynamicPriceConfigService.buildFeedInTariffScheduleFromForecast(
        rawConfig,
        prepared.simulationConfig,
        prepared.forecast,
      );
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
      const batteryControlCapabilities = this.batteryControlBackend.getCapabilities();

      const snapshot = this.simulationService.runSimulation({
        config: prepared.simulationConfig,
        batteryControlCapabilities,
        liveState: prepared.liveState,
        forecast: prepared.forecast,
        gridFeeEurPerKwhBySlot: prepared.gridFeeEurPerKwhBySlot,
        feedInTariffEurPerKwhBySlot: feedInTariffEurPerKwhBySlot ?? undefined,
        solarForecast: prepared.solarForecast,
        forecastEras: prepared.forecastEras,
        demandForecast: prepared.demandForecast,
        warnings: prepared.warnings,
        errors: prepared.errors,
        priceSnapshotEurPerKwh: prepared.priceSnapshot,
        observations: {
          gridPowerW: prepared.liveGridPowerW,
          solarPowerW: prepared.liveSolarPowerW,
          homePowerW: prepared.liveHomePowerW,
          evChargePowerW: prepared.liveEvChargePowerW,
          siteDemandPowerW: prepared.liveSiteDemandPowerW,
        },
      });
      this.logger.log("Seeded snapshot using config data.");
      await this.applyFronius(snapshot);
      this.modelTrainingCoordinator.maybeStartTraining(effectiveConfig);
    } catch (error) {
      this.logger.error(`Simulation seed failed: ${describeError(error)}`);
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

  private async applyFronius(snapshot: Awaited<ReturnType<SimulationService["runSimulation"]>>): Promise<void> {
    try {
      const command = this.optimisationCommandTranslator.fromSimulationSnapshot(snapshot);
      const result = await this.batteryControlBackend.applyOptimization(command);
      if (result.errorMessage) {
        this.logger.warn(`Snapshot flagged with error: ${result.errorMessage}`);
        this.simulationService.appendErrorsToLatestSnapshot([result.errorMessage]);
      }
    } catch (error) {
      this.logger.warn(`Fronius integration failed: ${describeError(error)}`);
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
      this.seedFromConfig().catch((error) => this.logger.error(`Scheduled run failed: ${describeError(error)}`));
    }, delayMs);
    this.logger.log(`Next simulation scheduled in ${(delayMs / 60000).toFixed(2)} minutes`);
  }

}
