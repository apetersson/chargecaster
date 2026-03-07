import { Inject, Injectable, Logger } from "@nestjs/common";
import type { HistoryPoint, SimulationConfig, SnapshotPayload } from "@chargecaster/domain";
import { StorageService } from "../storage/storage.service";
import { normalizeHistoryList } from "./history.serializer";

const WATTS_PER_KW = 1000;
const MS_PER_HOUR = 3600_000;
const HOURS_24 = 24;

export interface BacktestInterval {
  timestamp: string;
  duration_hours: number;
  price_eur_per_kwh: number;
  home_power_w: number;
  solar_power_w: number;
  actual_grid_power_w: number;
  actual_soc_percent: number;
  simulated_soc_percent: number;
  simulated_grid_power_w: number;
  actual_cost_eur: number;
  simulated_cost_eur: number;
}

export interface BacktestResult {
  generated_at: string;
  intervals: BacktestInterval[];
  actual_total_cost_eur: number;
  simulated_total_cost_eur: number;
  actual_final_soc_percent: number;
  simulated_final_soc_percent: number;
  soc_value_adjustment_eur: number;
  adjusted_actual_cost_eur: number;
  adjusted_simulated_cost_eur: number;
  savings_eur: number;
  avg_price_eur_per_kwh: number;
  history_points_used: number;
  span_hours: number;
}

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  run(snapshot: SnapshotPayload, config: SimulationConfig): BacktestResult {
    const history = this.loadLast24hHistory();
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
      const solarPowerW = current.solar_power_w != null && Number.isFinite(current.solar_power_w)
        ? Math.max(0, current.solar_power_w)
        : 0;
      const actualGridPowerW = current.grid_power_w != null && Number.isFinite(current.grid_power_w)
        ? current.grid_power_w
        : homePowerW - solarPowerW;
      const actualSocPercent = current.battery_soc_percent ?? 50;

      // Actual cost: positive grid = import, negative = export
      const actualGridKwh = (actualGridPowerW / WATTS_PER_KW) * durationHours;
      const actualCost = actualGridKwh >= 0
        ? actualGridKwh * importPriceEur
        : actualGridKwh * feedInTariffEur;

      // Simulate "auto" mode: battery covers net load, charges from solar surplus, never from grid
      const netLoadW = homePowerW - solarPowerW;

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
    const marginalPrice = this.deriveMarginalDischargePrice(snapshot, config);
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
}
