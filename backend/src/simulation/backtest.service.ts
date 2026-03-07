import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { BacktestResultSummary, SimulationConfig, SnapshotPayload } from "@chargecaster/domain";
import { StorageService } from "../storage/storage.service";
import {
  DAILY_BACKTEST_STRATEGY,
  type BacktestResult,
  type DailyBacktestEntry,
  type DailyBacktestStrategy,
} from "./daily-backtest.strategy";

const BACKTEST_CACHE_VERSION = 1;

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(DAILY_BACKTEST_STRATEGY) private readonly strategy: DailyBacktestStrategy,
  ) {}

  run(snapshot: SnapshotPayload, config: SimulationConfig): BacktestResult {
    return this.strategy.run(snapshot, config);
  }

  runDailyHistory(
    snapshot: SnapshotPayload,
    config: SimulationConfig,
    limit: number,
    skip: number,
  ): { entries: DailyBacktestEntry[]; hasMore: boolean } {
    const index = this.strategy.loadDailyHistoryIndex();
    const hasMore = skip + limit < index.availableDays.length;
    const pageDays = index.availableDays.slice(skip, skip + limit);
    const configFingerprint = this.buildCacheFingerprint(config);
    const cachedDates = pageDays.filter((date) => this.strategy.isCacheEligibleDay(date, index));
    const cachedSummaries = this.storage.listDailyBacktestSummaries(configFingerprint, cachedDates);
    const cachedByDate = new Map(cachedSummaries.map((entry) => [entry.date, entry.payload]));
    const summariesToCache: { date: string; configFingerprint: string; payload: BacktestResultSummary }[] = [];
    const entries: DailyBacktestEntry[] = [];

    for (const date of pageDays) {
      if (date !== index.yesterday) {
        const cached = cachedByDate.get(date);
        if (cached) {
          entries.push({date, result: this.inflateSummary(cached)});
          continue;
        }
      }

      const liveEntry = this.strategy.buildDailyEntry(date, config, {snapshot});
      if (!liveEntry) {
        continue;
      }
      entries.push(liveEntry);

      if (date !== index.yesterday && this.strategy.isCacheEligibleDay(date, index)) {
        summariesToCache.push({
          date,
          configFingerprint,
          payload: this.toSummary(liveEntry.result),
        });
      }
    }

    if (summariesToCache.length > 0) {
      this.storage.upsertDailyBacktestSummaries(summariesToCache);
    }

    this.logger.log(`Daily backtest: skip=${skip} limit=${limit} -> ${entries.length} days, hasMore=${hasMore}`);
    return {entries, hasMore};
  }

  materializeHistoricalDailyBacktests(
    config: SimulationConfig,
    options?: { dates?: string[]; today?: string; missingOnly?: boolean },
  ): { materialized: number; skipped: number } {
    const index = this.strategy.loadDailyHistoryIndex(options?.today);
    const configFingerprint = this.buildCacheFingerprint(config);
    const requestedDates = options?.dates ?? index.availableDays;
    let targetDates = requestedDates.filter((date) => this.strategy.isCacheEligibleDay(date, index));

    if (options?.missingOnly && targetDates.length > 0) {
      const existingDates = new Set(
        this.storage.listDailyBacktestSummaries(configFingerprint, targetDates).map((entry) => entry.date),
      );
      targetDates = targetDates.filter((date) => !existingDates.has(date));
    }

    const summaries: { date: string; configFingerprint: string; payload: BacktestResultSummary }[] = [];

    for (const date of targetDates) {
      const entry = this.strategy.buildDailyEntry(date, config);
      if (!entry) {
        continue;
      }
      summaries.push({
        date,
        configFingerprint,
        payload: this.toSummary(entry.result),
      });
    }

    if (summaries.length > 0) {
      this.storage.upsertDailyBacktestSummaries(summaries);
    }

    const skipped = requestedDates.length - summaries.length;
    this.logger.log(
      `Materialized ${summaries.length} daily backtests (requested=${requestedDates.length}, skipped=${skipped})`,
    );
    return {materialized: summaries.length, skipped};
  }

  buildCacheFingerprint(config: SimulationConfig): string {
    const serialized = JSON.stringify({
      version: BACKTEST_CACHE_VERSION,
      strategy: this.strategy.name,
      config,
    });
    return createHash("sha256").update(serialized).digest("hex");
  }

  private toSummary(result: BacktestResult): BacktestResultSummary {
    return {
      generated_at: result.generated_at,
      actual_total_cost_eur: result.actual_total_cost_eur,
      simulated_total_cost_eur: result.simulated_total_cost_eur,
      actual_final_soc_percent: result.actual_final_soc_percent,
      simulated_final_soc_percent: result.simulated_final_soc_percent,
      soc_value_adjustment_eur: result.soc_value_adjustment_eur,
      adjusted_actual_cost_eur: result.adjusted_actual_cost_eur,
      adjusted_simulated_cost_eur: result.adjusted_simulated_cost_eur,
      savings_eur: result.savings_eur,
      avg_price_eur_per_kwh: result.avg_price_eur_per_kwh,
      history_points_used: result.history_points_used,
      span_hours: result.span_hours,
    };
  }

  private inflateSummary(summary: BacktestResultSummary): BacktestResult {
    return {
      ...summary,
      intervals: [],
    };
  }
}
