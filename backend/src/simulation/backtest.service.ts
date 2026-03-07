import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { BacktestResultSummary, HistoryPoint, SimulationConfig, SnapshotPayload } from "@chargecaster/domain";
import { StorageService, type HistoryDayStatRecord } from "../storage/storage.service";
import { normalizeHistoryList } from "./history.serializer";

const WATTS_PER_KW = 1000;
const MS_PER_HOUR = 3600_000;
const HOURS_24 = 24;
const BACKTEST_CACHE_VERSION = 1;

export interface BacktestInterval {
  timestamp: string;
  duration_hours: number;
  price_eur_per_kwh: number;
  home_power_w: number;
  site_demand_power_w: number;
  synthetic_hidden_load_w: number;
  solar_power_w: number;
  actual_grid_power_w: number;
  actual_soc_percent: number;
  simulated_soc_percent: number;
  simulated_grid_power_w: number;
  actual_cost_eur: number;
  simulated_cost_eur: number;
}

export interface BacktestResult extends BacktestResultSummary {
  intervals: BacktestInterval[];
}

export interface DailyBacktestEntry {
  date: string;
  result: BacktestResult;
}

interface DailyHistoryIndex {
  today: string;
  yesterday: string;
  availableDays: string[];
  completeDays: Set<string>;
}

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  run(snapshot: SnapshotPayload, config: SimulationConfig): BacktestResult {
    const history = this.loadLast24hHistory();
    return this.runForHistory(history, config, {snapshot});
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
    const snapshotMarginalPrice = this.deriveMarginalDischargePrice(snapshot, config);
    const cachedDates = pageDays.filter((date) => this.isCacheEligibleDay(date, index));
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

      const liveEntry = this.buildDailyEntry(date, config, {
        snapshot,
        fallbackMarginalPrice: snapshotMarginalPrice,
      });
      if (!liveEntry) {
        continue;
      }
      entries.push(liveEntry);

      if (date !== index.yesterday && this.isCacheEligibleDay(date, index)) {
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

    this.logger.log(`Daily backtest: skip=${skip} limit=${limit} → ${entries.length} days, hasMore=${hasMore}`);
    return { entries, hasMore };
  }

  materializeHistoricalDailyBacktests(
    config: SimulationConfig,
    options?: { dates?: string[]; today?: string },
  ): { materialized: number; skipped: number } {
    const index = this.loadDailyHistoryIndex(options?.today);
    const configFingerprint = this.buildCacheFingerprint(config);
    const requestedDates = options?.dates ?? index.availableDays;
    const targetDates = requestedDates.filter((date) => this.isCacheEligibleDay(date, index));
    const summaries: { date: string; configFingerprint: string; payload: BacktestResultSummary }[] = [];

    for (const date of targetDates) {
      const entry = this.buildDailyEntry(date, config);
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
      config,
    });
    return createHash("sha256").update(serialized).digest("hex");
  }

  /** Time-weighted average of (price_eur_per_kwh + gridFee) over a set of history points. */
  private deriveMarginalPriceFromHistory(points: HistoryPoint[], gridFeeEur: number): number | null {
    let totalWeightedPrice = 0;
    let totalHours = 0;
    for (let i = 0; i < points.length - 1; i++) {
      const p = points[i];
      if (p.price_eur_per_kwh == null || !Number.isFinite(p.price_eur_per_kwh)) {
        continue;
      }
      const t0 = new Date(p.timestamp).getTime();
      const t1 = new Date(points[i + 1].timestamp).getTime();
      const hours = (t1 - t0) / MS_PER_HOUR;
      if (hours <= 0 || hours > 2) {
        continue;
      }
      totalWeightedPrice += (p.price_eur_per_kwh + gridFeeEur) * hours;
      totalHours += hours;
    }
    return totalHours > 0 ? totalWeightedPrice / totalHours : null;
  }

  private nextUtcDate(date: string): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  private previousUtcDate(date: string): string {
    const d = new Date(`${date}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
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

  private buildDailyEntry(
    date: string,
    config: SimulationConfig,
    options?: {
      snapshot?: SnapshotPayload;
      fallbackMarginalPrice?: number;
    },
  ): DailyBacktestEntry | null {
    const points = this.loadUtcDayHistory(date);
    if (points.length < 2) {
      return null;
    }
    const gridFeeEur = Number(config.price.grid_fee_eur_per_kwh ?? 0);
    const nextDayPoints = this.loadUtcDayHistory(this.nextUtcDate(date));
    const marginalPrice =
      (nextDayPoints.length >= 2
        ? this.deriveMarginalPriceFromHistory(nextDayPoints, gridFeeEur)
        : null) ?? options?.fallbackMarginalPrice ?? null;

    if (marginalPrice == null && !options?.snapshot) {
      return null;
    }

    const result = this.runForHistory(points, config, {
      snapshot: options?.snapshot,
      marginalPrice: marginalPrice ?? undefined,
    });
    if (result.history_points_used < 2) {
      return null;
    }
    return {date, result};
  }

  private loadUtcDayHistory(date: string): HistoryPoint[] {
    const start = `${date}T00:00:00.000Z`;
    const end = `${this.nextUtcDate(date)}T00:00:00.000Z`;
    const records = this.storage.listHistoryRangeAsc(start, end);
    return normalizeHistoryList(records.map((record) => record.payload));
  }

  private isCompleteUtcDay(points: HistoryPoint[]): boolean {
    if (points.length < 2) {
      return false;
    }

    const day = points[0].timestamp.slice(0, 10);
    const dayStart = new Date(`${day}T00:00:00Z`).getTime();
    const dayEnd = dayStart + HOURS_24 * MS_PER_HOUR;
    const firstPoint = new Date(points[0].timestamp).getTime();
    const lastPoint = new Date(points[points.length - 1].timestamp).getTime();
    const boundaryToleranceMs = MS_PER_HOUR * 2;

    return firstPoint - dayStart <= boundaryToleranceMs && dayEnd - lastPoint <= boundaryToleranceMs;
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

  private runForHistory(
    history: HistoryPoint[],
    config: SimulationConfig,
    options?: {
      snapshot?: SnapshotPayload;
      marginalPrice?: number;
    },
  ): BacktestResult {
    if (history.length < 2) {
      return this.emptyResult("Not enough history data for backtest");
    }

    const capacityKwh = Number(config.battery.capacity_kwh ?? 0);
    if (capacityKwh <= 0) {
      return this.emptyResult("Battery capacity not configured");
    }

    const floorSocPercent = Math.max(0, Number(config.battery.auto_mode_floor_soc ?? 0));
    const maxDischargePowerW = config.battery.max_discharge_power_w != null
      ? Math.max(0, Number(config.battery.max_discharge_power_w))
      : null;
    const maxChargePowerSolarW = config.battery.max_charge_power_solar_w != null
      ? Math.max(0, Number(config.battery.max_charge_power_solar_w))
      : null;
    const gridFeeEur = Number(config.price.grid_fee_eur_per_kwh ?? 0);
    const feedInTariffEur = Math.max(0, Number(config.price.feed_in_tariff_eur_per_kwh ?? 0));
    const houseLoadWFallback = Number(config.logic.house_load_w ?? 1200);

    const firstSoc = history[0].battery_soc_percent;
    if (firstSoc == null || !Number.isFinite(firstSoc)) {
      return this.emptyResult("First history point has no SOC");
    }

    let simSocPercent = firstSoc;
    const intervals: BacktestInterval[] = [];
    let actualTotalCost = 0;
    let simulatedTotalCost = 0;

    for (let i = 0; i < history.length - 1; i++) {
      const current = history[i];
      const next = history[i + 1];

      const t0 = new Date(current.timestamp).getTime();
      const t1 = new Date(next.timestamp).getTime();
      const durationMs = t1 - t0;
      if (durationMs <= 0 || durationMs > MS_PER_HOUR * 2) {
        continue;
      }
      const durationHours = durationMs / MS_PER_HOUR;

      const priceEur = Number(current.price_eur_per_kwh ?? 0);
      const importPriceEur = priceEur + gridFeeEur;

      const homePowerW = current.home_power_w != null && Number.isFinite(current.home_power_w)
        ? current.home_power_w
        : houseLoadWFallback;
      const evChargePowerW = current.ev_charge_power_w != null && Number.isFinite(current.ev_charge_power_w)
        ? Math.max(0, current.ev_charge_power_w)
        : null;
      const solarPowerW = current.solar_power_w != null && Number.isFinite(current.solar_power_w)
        ? Math.max(0, current.solar_power_w)
        : 0;
      const actualSocPercent = current.battery_soc_percent ?? 50;
      const nextSocPercent = next.battery_soc_percent ?? actualSocPercent;
      const inferredBatteryPowerW = this.inferObservedBatteryPowerW(
        actualSocPercent,
        nextSocPercent,
        capacityKwh,
        durationHours,
      );
      const measuredSiteDemandW = current.site_demand_power_w != null && Number.isFinite(current.site_demand_power_w)
        ? Math.max(0, current.site_demand_power_w)
        : evChargePowerW != null
          ? homePowerW + evChargePowerW
          : null;
      const syntheticSiteDemandW = Math.max(
        homePowerW,
        actualGridPowerWOrFallback(current.grid_power_w, homePowerW, solarPowerW) + solarPowerW + inferredBatteryPowerW,
      );
      const siteDemandW = measuredSiteDemandW ?? syntheticSiteDemandW;
      const hiddenLoadW = Math.max(0, siteDemandW - homePowerW);
      const actualGridPowerW = current.grid_power_w != null && Number.isFinite(current.grid_power_w)
        ? current.grid_power_w
        : siteDemandW - solarPowerW - inferredBatteryPowerW;

      // Actual cost: positive grid = import, negative = export
      const actualGridKwh = (actualGridPowerW / WATTS_PER_KW) * durationHours;
      const actualCost = actualGridKwh >= 0
        ? actualGridKwh * importPriceEur
        : actualGridKwh * feedInTariffEur;

      // Simulate "auto" mode against the total site demand, not EVCC's wallbox-excluded home power.
      const netLoadW = siteDemandW - solarPowerW;

      let simGridPowerW: number;
      if (netLoadW > 0) {
        // Need power from grid or battery
        const availableEnergyKwh = capacityKwh * (simSocPercent - floorSocPercent) / 100;
        const maxDischargeKwh = maxDischargePowerW != null
          ? (maxDischargePowerW / WATTS_PER_KW) * durationHours
          : availableEnergyKwh;
        const desiredDischargeKwh = (netLoadW / WATTS_PER_KW) * durationHours;
        const actualDischargeKwh = Math.max(0, Math.min(desiredDischargeKwh, availableEnergyKwh, maxDischargeKwh));

        const socDrop = (actualDischargeKwh / capacityKwh) * 100;
        simSocPercent = Math.max(floorSocPercent, simSocPercent - socDrop);

        const remainingLoadKwh = desiredDischargeKwh - actualDischargeKwh;
        simGridPowerW = (remainingLoadKwh / durationHours) * WATTS_PER_KW;
      } else {
        // Solar surplus: charge battery, export rest
        const surplusW = -netLoadW;
        const headroomKwh = capacityKwh * (100 - simSocPercent) / 100;
        const maxChargeKwh = maxChargePowerSolarW != null
          ? (maxChargePowerSolarW / WATTS_PER_KW) * durationHours
          : headroomKwh;
        const surplusKwh = (surplusW / WATTS_PER_KW) * durationHours;
        const chargeKwh = Math.max(0, Math.min(surplusKwh, headroomKwh, maxChargeKwh));

        const socGain = (chargeKwh / capacityKwh) * 100;
        simSocPercent = Math.min(100, simSocPercent + socGain);

        const exportKwh = surplusKwh - chargeKwh;
        simGridPowerW = -(exportKwh / durationHours) * WATTS_PER_KW;
      }

      const simGridKwh = (simGridPowerW / WATTS_PER_KW) * durationHours;
      const simCost = simGridKwh >= 0
        ? simGridKwh * importPriceEur
        : simGridKwh * feedInTariffEur;

      actualTotalCost += actualCost;
      simulatedTotalCost += simCost;

      intervals.push({
        timestamp: current.timestamp,
        duration_hours: durationHours,
        price_eur_per_kwh: priceEur,
        home_power_w: homePowerW,
        site_demand_power_w: siteDemandW,
        synthetic_hidden_load_w: measuredSiteDemandW == null ? hiddenLoadW : 0,
        solar_power_w: solarPowerW,
        actual_grid_power_w: actualGridPowerW,
        actual_soc_percent: actualSocPercent,
        simulated_soc_percent: simSocPercent,
        simulated_grid_power_w: simGridPowerW,
        actual_cost_eur: actualCost,
        simulated_cost_eur: simCost,
      });
    }

    if (intervals.length === 0) {
      return this.emptyResult("No valid intervals in history");
    }

    // Value remaining SOC at the marginal discharge price: the weighted-average price of
    // eras where the simulation expects the battery to actually discharge (strategy=auto with
    // negative grid_energy). This reflects what the stored energy is truly worth.
    const marginalPrice =
      options?.marginalPrice ?? (options?.snapshot ? this.deriveMarginalDischargePrice(options.snapshot, config) : null);
    if (marginalPrice == null) {
      return this.emptyResult("Missing marginal price for backtest");
    }
    const actualFinalSoc = history[history.length - 1].battery_soc_percent ?? simSocPercent;
    const simFinalSoc = simSocPercent;

    const socDiffPercent = actualFinalSoc - simFinalSoc;
    const socDiffKwh = (socDiffPercent / 100) * capacityKwh;
    const socValueAdj = socDiffKwh * marginalPrice;

    const adjustedActualCost = actualTotalCost - socValueAdj;
    const adjustedSimCost = simulatedTotalCost;

    const firstTs = new Date(history[0].timestamp).getTime();
    const lastTs = new Date(history[history.length - 1].timestamp).getTime();
    const spanHours = (lastTs - firstTs) / MS_PER_HOUR;

    this.logger.log(
      `Backtest complete: ${intervals.length} intervals, span=${spanHours.toFixed(1)}h, ` +
      `actual=${actualTotalCost.toFixed(3)}EUR, simulated=${simulatedTotalCost.toFixed(3)}EUR, ` +
      `SOC adj=${socValueAdj.toFixed(3)}EUR (marginal=${(marginalPrice * 100).toFixed(1)}ct/kWh), ` +
      `savings=${(adjustedSimCost - adjustedActualCost).toFixed(3)}EUR`,
    );

    return {
      generated_at: new Date().toISOString(),
      intervals,
      actual_total_cost_eur: actualTotalCost,
      simulated_total_cost_eur: simulatedTotalCost,
      actual_final_soc_percent: actualFinalSoc,
      simulated_final_soc_percent: simFinalSoc,
      soc_value_adjustment_eur: socValueAdj,
      adjusted_actual_cost_eur: adjustedActualCost,
      adjusted_simulated_cost_eur: adjustedSimCost,
      savings_eur: adjustedSimCost - adjustedActualCost,
      avg_price_eur_per_kwh: marginalPrice,
      history_points_used: history.length,
      span_hours: spanHours,
    };
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

  private loadLast24hHistory(): HistoryPoint[] {
    // Fetch generous limit to cover 24h (at 5min intervals = 288 points)
    const records = this.storage.listHistory(500);
    const allPoints = normalizeHistoryList(records.map((r) => r.payload));
    const cutoff = Date.now() - HOURS_24 * MS_PER_HOUR;
    return allPoints.filter((p) => new Date(p.timestamp).getTime() >= cutoff);
  }

  private deriveMarginalDischargePrice(snapshot: SnapshotPayload, config: SimulationConfig): number {
    const gridFee = Number(config.price.grid_fee_eur_per_kwh ?? 0);
    const eras = snapshot.forecast_eras;
    const oracle = snapshot.oracle_entries;

    // Build a map from era_id to its import price
    const eraPriceMap = new Map<string, number>();
    for (const era of eras) {
      const costSource = era.sources.find((s) => s.type === "cost");
      if (costSource) {
        eraPriceMap.set(era.era_id, costSource.payload.price_eur_per_kwh + gridFee);
      }
    }

    // Weight prices by the amount of energy the simulation expects to discharge
    // (oracle strategy=auto with SOC drop, i.e. the battery is actually being used)
    let totalWeightedPrice = 0;
    let totalDischargeWh = 0;
    for (const entry of oracle) {
      if (entry.strategy !== "auto") {
        continue;
      }
      const startSoc = entry.start_soc_percent ?? 0;
      const endSoc = entry.end_soc_percent ?? 0;
      if (endSoc >= startSoc) {
        continue; // not discharging
      }
      const price = eraPriceMap.get(entry.era_id);
      if (price == null) {
        continue;
      }
      const dischargeWh = Math.abs(entry.grid_energy_wh ?? 0);
      if (dischargeWh <= 0) {
        continue;
      }
      totalWeightedPrice += price * dischargeWh;
      totalDischargeWh += dischargeWh;
    }

    if (totalDischargeWh > 0) {
      return totalWeightedPrice / totalDischargeWh;
    }

    // Fallback: time-weighted average over all forecast eras
    let totalHourPrice = 0;
    let totalHours = 0;
    for (const era of eras) {
      const hours = Number(era.duration_hours ?? 0);
      const costSource = era.sources.find((s) => s.type === "cost");
      if (costSource && hours > 0) {
        totalHourPrice += (costSource.payload.price_eur_per_kwh + gridFee) * hours;
        totalHours += hours;
      }
    }
    if (totalHours > 0) {
      return totalHourPrice / totalHours;
    }

    const snapshotPrice = snapshot.price_snapshot_eur_per_kwh;
    return (typeof snapshotPrice === "number" && Number.isFinite(snapshotPrice))
      ? snapshotPrice + gridFee
      : gridFee;
  }

  private emptyResult(reason: string): BacktestResult {
    this.logger.warn(`Backtest skipped: ${reason}`);
    return {
      generated_at: new Date().toISOString(),
      intervals: [],
      actual_total_cost_eur: 0,
      simulated_total_cost_eur: 0,
      actual_final_soc_percent: 0,
      simulated_final_soc_percent: 0,
      soc_value_adjustment_eur: 0,
      adjusted_actual_cost_eur: 0,
      adjusted_simulated_cost_eur: 0,
      savings_eur: 0,
      avg_price_eur_per_kwh: 0,
      history_points_used: 0,
      span_hours: 0,
    };
  }

  private inferObservedBatteryPowerW(
    currentSocPercent: number,
    nextSocPercent: number,
    capacityKwh: number,
    durationHours: number,
  ): number {
    if (!Number.isFinite(currentSocPercent) || !Number.isFinite(nextSocPercent) || durationHours <= 0) {
      return 0;
    }
    const storedEnergyDeltaKwh = ((nextSocPercent - currentSocPercent) / 100) * capacityKwh;
    return -(storedEnergyDeltaKwh / durationHours) * WATTS_PER_KW;
  }
}

function actualGridPowerWOrFallback(
  rawGridPowerW: number | null | undefined,
  homePowerW: number,
  solarPowerW: number,
): number {
  return rawGridPowerW != null && Number.isFinite(rawGridPowerW)
    ? rawGridPowerW
    : homePowerW - solarPowerW;
}
