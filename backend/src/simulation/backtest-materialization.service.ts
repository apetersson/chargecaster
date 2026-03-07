import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";

import { describeError } from "@chargecaster/domain";
import { RuntimeConfigService } from "../config/runtime-config.service";
import { SimulationConfigFactory } from "../config/simulation-config.factory";
import { BacktestService } from "./backtest.service";

@Injectable()
export class BacktestMaterializationService implements OnModuleDestroy {
  private readonly logger = new Logger(BacktestMaterializationService.name);
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private runInProgress = false;

  constructor(
    @Inject(BacktestService) private readonly backtestService: BacktestService,
    @Inject(RuntimeConfigService) private readonly runtimeConfig: RuntimeConfigService,
    @Inject(SimulationConfigFactory) private readonly configFactory: SimulationConfigFactory,
  ) {}

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.runStartupCatchup();
    this.scheduleNextRun();
  }

  onModuleDestroy(): void {
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  private runStartupCatchup(): void {
    this.runMaterialization("startup", undefined, true);
  }

  private runScheduledRefresh(): void {
    const targetDate = this.computeDayMinusTwoUtcDate();
    this.runMaterialization("scheduled", [targetDate], false);
  }

  private runMaterialization(reason: "startup" | "scheduled", dates?: string[], missingOnly = false): void {
    if (this.runInProgress) {
      this.logger.warn(`Backtest materialization already running; skipping ${reason} request.`);
      return;
    }

    this.runInProgress = true;
    try {
      const config = this.configFactory.create(this.runtimeConfig.getDocumentRef());
      const result = this.backtestService.materializeHistoricalDailyBacktests(config, {dates, missingOnly});
      this.logger.log(
        `Backtest materialization ${reason} complete: materialized=${result.materialized}, skipped=${result.skipped}`,
      );
    } catch (error) {
      this.logger.error(`Backtest materialization ${reason} failed: ${describeError(error)}`);
    } finally {
      this.runInProgress = false;
    }
  }

  private scheduleNextRun(): void {
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }

    const nextRunAt = this.computeNextUtcMidnight();
    const delayMs = Math.max(1000, nextRunAt.getTime() - Date.now());
    this.schedulerTimer = setTimeout(() => {
      try {
        this.runScheduledRefresh();
      } catch (error) {
        this.logger.error(`Scheduled backtest materialization failed: ${describeError(error)}`);
      } finally {
        this.scheduleNextRun();
      }
    }, delayMs);

    this.logger.log(`Next daily backtest materialization scheduled for ${nextRunAt.toISOString()}`);
  }

  private computeNextUtcMidnight(): Date {
    const now = new Date();
    return new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
      0,
      0,
      0,
      0,
    ));
  }

  private computeDayMinusTwoUtcDate(): string {
    const now = new Date();
    const target = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() - 2,
      0,
      0,
      0,
      0,
    ));
    return target.toISOString().slice(0, 10);
  }
}
