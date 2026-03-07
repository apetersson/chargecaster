import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { BacktestResultSummary, SimulationConfig, SnapshotPayload } from "@chargecaster/domain";
import { StorageService, type DailyBacktestSummaryRecord, type HistoryDayStatRecord } from "../storage/storage.service";
import {
  DAILY_BACKTEST_STRATEGY,
  type BacktestResult,
  type DailyBacktestEntry,
  type DailyHistoryIndex,
  type DailyBacktestStrategy,
} from "./daily-backtest.strategy";

const BACKTEST_CACHE_VERSION = 2;
const MS_PER_HOUR = 3600_000;
const HOURS_24 = 24;

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
    const index = this.loadDailyHistoryIndex();
    const hasMore = skip + limit < index.availableDays.length;
    const pageDays = index.availableDays.slice(skip, skip + limit);
    const configFingerprint = this.buildCacheFingerprint(config);
    const cachedDates = pageDays.filter((date) => this.isCacheEligibleDay(date, index));
    const cachedSummaries = this.storage.listDailyBacktestSummaries(configFingerprint, cachedDates);
    const computed = this.buildEntriesForDates(pageDays, config, index, configFingerprint, {
      snapshot,
      cachedSummaries,
    });
    if (computed.summariesToCache.length > 0) {
      this.storage.upsertDailyBacktestSummaries(computed.summariesToCache);
    }

    this.logger.log(`Daily backtest: skip=${skip} limit=${limit} -> ${computed.entries.length} days, hasMore=${hasMore}`);
    return {entries: computed.entries, hasMore};
  }

  getDailyHistoryDetail(
    snapshot: SnapshotPayload,
    config: SimulationConfig,
    date: string,
  ): DailyBacktestEntry | null {
    const index = this.loadDailyHistoryIndex();
    if (!index.completeDays.has(date)) {
      this.logger.warn(`Daily backtest detail requested for incomplete or missing day ${date}`);
      return null;
    }

    const configFingerprint = this.buildCacheFingerprint(config);
    const computed = this.buildEntriesForDates([date], config, index, configFingerprint, {
      snapshot,
      cachedSummaries: [],
    });
    if (computed.summariesToCache.length > 0) {
      this.storage.upsertDailyBacktestSummaries(computed.summariesToCache);
    }

    const detail = computed.entries[0] ?? null;
    this.logger.log(`Daily backtest detail: date=${date} -> ${computed.entries.length > 0 ? "hit" : "miss"}`);
    return detail;
  }

  materializeHistoricalDailyBacktests(
    config: SimulationConfig,
    options?: { dates?: string[]; today?: string; missingOnly?: boolean },
  ): { materialized: number; skipped: number } {
    const index = this.loadDailyHistoryIndex(options?.today);
    const configFingerprint = this.buildCacheFingerprint(config);
    const requestedDates = options?.dates ?? index.availableDays;
    let targetDates = requestedDates.filter((date) => this.isCacheEligibleDay(date, index));

    if (options?.missingOnly && targetDates.length > 0) {
      const existingDates = new Set(
        this.storage.listDailyBacktestSummaries(configFingerprint, targetDates).map((entry) => entry.date),
      );
      targetDates = targetDates.filter((date) => !existingDates.has(date));
    }

    const computed = this.buildEntriesForDates(targetDates, config, index, configFingerprint);
    if (computed.summariesToCache.length > 0) {
      this.storage.upsertDailyBacktestSummaries(computed.summariesToCache);
    }

    const materialized = computed.entries.length;
    const skipped = requestedDates.length - materialized;
    this.logger.log(
      `Materialized ${materialized} daily backtests (requested=${requestedDates.length}, skipped=${skipped})`,
    );
    return {materialized, skipped};
  }

  buildCacheFingerprint(config: SimulationConfig): string {
    const serialized = JSON.stringify({
      version: BACKTEST_CACHE_VERSION,
      strategy: this.strategy.name,
      config,
    });
    return createHash("sha256").update(serialized).digest("hex");
  }

  private buildEntriesForDates(
    requestedDates: string[],
    config: SimulationConfig,
    index: DailyHistoryIndex,
    configFingerprint: string,
    options?: {
      snapshot?: SnapshotPayload;
      cachedSummaries?: DailyBacktestSummaryRecord[];
    },
  ): {
    entries: DailyBacktestEntry[];
    summariesToCache: {
      date: string;
      configFingerprint: string;
      strategy: string;
      simulatedStartSocPercent: number;
      simulatedFinalSocPercent: number;
      payload: BacktestResultSummary;
    }[];
  } {
    const cachedByDate = new Map((options?.cachedSummaries ?? []).map((entry) => [entry.date, entry]));
    const liveByDate = new Map<string, DailyBacktestEntry>();
    const summariesByDate = new Map<string, {
      date: string;
      configFingerprint: string;
      strategy: string;
      simulatedStartSocPercent: number;
      simulatedFinalSocPercent: number;
      payload: BacktestResultSummary;
    }>();

    const ensureLiveEntry = (date: string): DailyBacktestEntry | null => {
      const existing = liveByDate.get(date);
      if (existing) {
        return existing;
      }

      let initialSimSocPercent: number | null | undefined;
      if (this.strategy.requiresSequentialState) {
        initialSimSocPercent = this.resolveInitialSimSocPercent(
          date,
          index,
          configFingerprint,
          cachedByDate,
          liveByDate,
          ensureLiveEntry,
        );
      }

      const entry = this.strategy.buildDailyEntry(date, config, {
        snapshot: options?.snapshot,
        initialSimSocPercent,
      });
      if (!entry) {
        return null;
      }
      liveByDate.set(date, entry);

      if (date !== index.yesterday && this.isCacheEligibleDay(date, index)) {
        summariesByDate.set(date, {
          date,
          configFingerprint,
          strategy: this.strategy.name,
          simulatedStartSocPercent: entry.result.simulated_start_soc_percent,
          simulatedFinalSocPercent: entry.result.simulated_final_soc_percent,
          payload: this.toSummary(entry.result),
        });
      }

      return entry;
    };

    const sortedDates = [...requestedDates].sort();
    for (const date of sortedDates) {
      const cached = date !== index.yesterday ? cachedByDate.get(date) : undefined;
      if (!cached) {
        ensureLiveEntry(date);
      }
    }

    const entries = requestedDates.flatMap((date) => {
      const cached = date !== index.yesterday ? cachedByDate.get(date) : undefined;
      if (cached) {
        return [{date, result: this.inflateSummary(cached.payload)}];
      }
      const live = liveByDate.get(date);
      return live ? [live] : [];
    });
    const summariesToCache = [...summariesByDate.values()];
    return {entries, summariesToCache};
  }

  private resolveInitialSimSocPercent(
    date: string,
    index: DailyHistoryIndex,
    configFingerprint: string,
    cachedByDate: Map<string, DailyBacktestSummaryRecord>,
    liveByDate: Map<string, DailyBacktestEntry>,
    ensureLiveEntry: (date: string) => DailyBacktestEntry | null,
  ): number | null | undefined {
    const previousDate = this.previousUtcDate(date);
    if (!index.completeDays.has(previousDate)) {
      return undefined;
    }

    const livePrevious = liveByDate.get(previousDate);
    if (livePrevious) {
      return livePrevious.result.simulated_final_soc_percent;
    }

    const cachedPrevious = cachedByDate.get(previousDate);
    if (cachedPrevious) {
      return cachedPrevious.simulatedFinalSocPercent;
    }

    if (this.isCacheEligibleDay(previousDate, index)) {
      const loadedEntries = this.storage.listDailyBacktestSummaries(configFingerprint, [previousDate]);
      if (loadedEntries.length > 0) {
        const loaded = loadedEntries[0];
        cachedByDate.set(previousDate, loaded);
        return loaded.simulatedFinalSocPercent;
      }
    }

    if (previousDate === index.today) {
      return undefined;
    }

    if (this.isCacheEligibleDay(previousDate, index) || previousDate === index.yesterday) {
      const previousEntry = ensureLiveEntry(previousDate);
      if (previousEntry) {
        return previousEntry.result.simulated_final_soc_percent;
      }
    }

    return undefined;
  }

  private loadDailyHistoryIndex(today = new Date().toISOString().slice(0, 10)): DailyHistoryIndex {
    const stats = this.storage.listHistoryDayStatsBefore(today);
    const completeDays = new Set(
      stats
        .filter((stat) => this.isCompleteUtcDayStat(stat))
        .map((stat) => stat.date),
    );
    const availableDays = stats
      .map((stat) => stat.date)
      .filter((date) => completeDays.has(date));

    return {
      today,
      yesterday: this.previousUtcDate(today),
      availableDays,
      completeDays,
    };
  }

  private isCacheEligibleDay(date: string, index: DailyHistoryIndex): boolean {
    if (date >= index.yesterday) {
      return false;
    }
    return index.completeDays.has(this.nextUtcDate(date));
  }

  private nextUtcDate(date: string): string {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + 1);
    return value.toISOString().slice(0, 10);
  }

  private previousUtcDate(date: string): string {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() - 1);
    return value.toISOString().slice(0, 10);
  }

  private isCompleteUtcDayStat(stat: HistoryDayStatRecord): boolean {
    if (stat.pointCount < 2) {
      return false;
    }

    const dayStart = new Date(`${stat.date}T00:00:00Z`).getTime();
    const dayEnd = dayStart + HOURS_24 * MS_PER_HOUR;
    const firstPoint = new Date(stat.firstTimestamp).getTime();
    const lastPoint = new Date(stat.lastTimestamp).getTime();
    const boundaryToleranceMs = MS_PER_HOUR * 2;

    return firstPoint - dayStart <= boundaryToleranceMs && dayEnd - lastPoint <= boundaryToleranceMs;
  }

  private toSummary(result: BacktestResult): BacktestResultSummary {
    return {
      generated_at: result.generated_at,
      actual_total_cost_eur: result.actual_total_cost_eur,
      simulated_total_cost_eur: result.simulated_total_cost_eur,
      simulated_start_soc_percent: result.simulated_start_soc_percent,
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
