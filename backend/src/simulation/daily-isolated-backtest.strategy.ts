import { Inject, Injectable, Logger } from "@nestjs/common";
import type { HistoryPoint, SimulationConfig, SnapshotPayload } from "@chargecaster/domain";
import {
  Duration,
  Energy,
  EnergyPrice,
  Percentage,
  Power,
  computeGridEnergyCostEur,
  energyDeltaFromSocPercent,
  energyFromPower,
  energyFromSoc,
  inferBatteryPowerFromSocDelta,
  powerFromEnergy,
  socFromEnergy,
} from "@chargecaster/domain";
import { StorageService } from "../storage/storage.service";
import { normalizeHistoryList } from "./history.serializer";
import type {
  BacktestResult,
  BuildDailyBacktestOptions,
  DailyBacktestEntry,
  DailyBacktestStrategy,
} from "./daily-backtest.strategy";

const MS_PER_HOUR = 3600_000;
const HOURS_24 = 24;

@Injectable()
export class DailyIsolatedBacktestStrategy implements DailyBacktestStrategy {
  readonly name: string = "daily-isolated";
  readonly requiresSequentialState: boolean = false;
  protected readonly logger = new Logger(DailyIsolatedBacktestStrategy.name);

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  run(snapshot: SnapshotPayload, config: SimulationConfig): BacktestResult {
    const history = this.loadLast24hHistory();
    return this.runForHistory(history, config, {snapshot});
  }

  buildDailyEntry(
    date: string,
    config: SimulationConfig,
    options?: BuildDailyBacktestOptions,
  ): DailyBacktestEntry | null {
    const points = this.loadUtcDayHistory(date);
    if (points.length < 2) {
      return null;
    }
    const marginalPrice = this.resolveMarginalPrice(date, config, options);
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

  protected resolveMarginalPrice(
    date: string,
    config: SimulationConfig,
    options?: BuildDailyBacktestOptions,
  ): number | null {
    const gridFeeEur = Number(config.price.grid_fee_eur_per_kwh ?? 0);
    const nextDayPoints = this.loadUtcDayHistory(this.nextUtcDate(date));
    return (nextDayPoints.length >= 2
      ? this.deriveMarginalPriceFromHistory(nextDayPoints, gridFeeEur)
      : null) ?? options?.fallbackMarginalPrice ?? null;
  }

  protected deriveMarginalPriceFromHistory(points: HistoryPoint[], gridFeeEur: number): number | null {
    let totalWeightedPrice = 0;
    let totalHours = 0;
    for (let i = 0; i < points.length - 1; i += 1) {
      const point = points[i];
      if (point.price_eur_per_kwh == null || !Number.isFinite(point.price_eur_per_kwh)) {
        continue;
      }
      const t0 = new Date(point.timestamp).getTime();
      const t1 = new Date(points[i + 1].timestamp).getTime();
      const hours = (t1 - t0) / MS_PER_HOUR;
      if (hours <= 0 || hours > 2) {
        continue;
      }
      totalWeightedPrice += (point.price_eur_per_kwh + gridFeeEur) * hours;
      totalHours += hours;
    }
    return totalHours > 0 ? totalWeightedPrice / totalHours : null;
  }

  protected nextUtcDate(date: string): string {
    const value = new Date(`${date}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() + 1);
    return value.toISOString().slice(0, 10);
  }

  protected loadUtcDayHistory(date: string): HistoryPoint[] {
    const start = `${date}T00:00:00.000Z`;
    const end = `${this.nextUtcDate(date)}T00:00:00.000Z`;
    const records = this.storage.listHistoryRangeAsc(start, end);
    return normalizeHistoryList(records.map((record) => record.payload));
  }

  protected runForHistory(
    history: HistoryPoint[],
    config: SimulationConfig,
    options?: {
      snapshot?: SnapshotPayload;
      marginalPrice?: number;
      initialSimSocPercent?: number | null;
    },
  ): BacktestResult {
    if (history.length < 2) {
      return this.emptyResult("Not enough history data for backtest");
    }

    const capacityKwh = Number(config.battery.capacity_kwh ?? 0);
    if (capacityKwh <= 0) {
      return this.emptyResult("Battery capacity not configured");
    }

    const capacity = Energy.fromKilowattHours(capacityKwh);
    const floorSoc = Percentage.fromPercent(Math.max(0, Number(config.battery.auto_mode_floor_soc ?? 0)));
    const maxDischargePower = config.battery.max_discharge_power_w != null
      ? Power.fromWatts(Math.max(0, Number(config.battery.max_discharge_power_w)))
      : null;
    const maxChargePowerSolar = config.battery.max_charge_power_solar_w != null
      ? Power.fromWatts(Math.max(0, Number(config.battery.max_charge_power_solar_w)))
      : null;
    const gridFeeEur = Number(config.price.grid_fee_eur_per_kwh ?? 0);
    const feedInTariffEur = Math.max(0, Number(config.price.feed_in_tariff_eur_per_kwh ?? 0));
    const houseLoadFallback = Power.fromWatts(2200);
    const marginalPrice =
      options?.marginalPrice ?? (options?.snapshot ? this.deriveMarginalDischargePrice(options.snapshot, config) : null);
    if (marginalPrice == null) {
      return this.emptyResult("Missing marginal price for backtest");
    }

    const firstSoc = history[0].battery_soc_percent;
    if (firstSoc == null || !Number.isFinite(firstSoc)) {
      return this.emptyResult("First history point has no SOC");
    }

    let simSocPercent = Number.isFinite(options?.initialSimSocPercent)
      ? Number(options?.initialSimSocPercent)
      : firstSoc;
    const initialRelativeSocDiffPercent = firstSoc - simSocPercent;
    const intervals: BacktestResult["intervals"] = [];
    let actualTotalCost = 0;
    let simulatedTotalCost = 0;
    let cumulativeCashSavings = 0;

    for (let i = 0; i < history.length - 1; i += 1) {
      const current = history[i];
      const next = history[i + 1];

      const t0 = new Date(current.timestamp).getTime();
      const t1 = new Date(next.timestamp).getTime();
      const durationMs = t1 - t0;
      if (durationMs <= 0 || durationMs > MS_PER_HOUR * 2) {
        continue;
      }
      const durationHours = durationMs / MS_PER_HOUR;
      const duration = Duration.fromMilliseconds(durationMs);

      const priceEur = Number(current.price_eur_per_kwh ?? 0);
      const importPrice = EnergyPrice.fromEurPerKwh(priceEur + gridFeeEur);
      const feedInTariff = EnergyPrice.fromEurPerKwh(feedInTariffEur);

      const homePower = current.home_power_w != null && Number.isFinite(current.home_power_w)
        ? Power.fromWatts(current.home_power_w)
        : houseLoadFallback;
      const evChargePower = current.ev_charge_power_w != null && Number.isFinite(current.ev_charge_power_w)
        ? Power.fromWatts(Math.max(0, current.ev_charge_power_w))
        : null;
      const solarPower = current.solar_power_w != null && Number.isFinite(current.solar_power_w)
        ? Power.fromWatts(Math.max(0, current.solar_power_w))
        : Power.zero();
      const actualSocPercent = current.battery_soc_percent ?? 50;
      const nextSocPercent = next.battery_soc_percent ?? actualSocPercent;
      const actualSoc = Percentage.fromPercent(actualSocPercent);
      const nextSoc = Percentage.fromPercent(nextSocPercent);
      const inferredBatteryPower = inferBatteryPowerFromSocDelta(
        actualSoc,
        nextSoc,
        capacity,
        duration,
      );
      const measuredSiteDemand = current.site_demand_power_w != null && Number.isFinite(current.site_demand_power_w)
        ? Power.fromWatts(Math.max(0, current.site_demand_power_w))
        : evChargePower != null
          ? homePower.add(evChargePower)
          : null;
      const syntheticSiteDemand = Power.fromWatts(Math.max(
        homePower.watts,
        actualGridPowerOrFallback(current.grid_power_w, homePower, solarPower).watts +
          solarPower.watts +
          inferredBatteryPower.watts,
      ));
      const siteDemand = measuredSiteDemand ?? syntheticSiteDemand;
      const hiddenLoad = Power.fromWatts(Math.max(0, siteDemand.watts - homePower.watts));
      const actualGridPower = current.grid_power_w != null && Number.isFinite(current.grid_power_w)
        ? Power.fromWatts(current.grid_power_w)
        : Power.fromWatts(siteDemand.watts - solarPower.watts - inferredBatteryPower.watts);

      const actualGridEnergy = energyFromPower(actualGridPower, duration);
      const actualCost = computeGridEnergyCostEur(actualGridEnergy, importPrice, feedInTariff);

      const netLoad = Power.fromWatts(siteDemand.watts - solarPower.watts);
      const simulatedSocStartPercent = simSocPercent;
      const actualChargePower = Power.fromWatts(Math.max(0, -inferredBatteryPower.watts));
      const actualSolarSurplus = Power.fromWatts(Math.max(0, solarPower.watts - siteDemand.watts));
      const actualChargeFromSolar = Power.fromWatts(Math.min(actualChargePower.watts, actualSolarSurplus.watts));
      const actualChargeFromGrid = Power.fromWatts(Math.max(0, actualChargePower.watts - actualChargeFromSolar.watts));
      let simulatedChargeFromSolar = Power.zero();

      let simGridPower: Power;
      if (netLoad.watts > 0) {
        const availableEnergy = energyFromSoc(
          Percentage.fromPercent(Math.max(0, simSocPercent - floorSoc.percent)),
          capacity,
        );
        const maxDischargeEnergy = maxDischargePower != null
          ? energyFromPower(maxDischargePower, duration)
          : availableEnergy;
        const desiredDischargeEnergy = energyFromPower(netLoad, duration);
        const actualDischargeEnergy = minEnergy(desiredDischargeEnergy, availableEnergy, maxDischargeEnergy);

        const socDrop = socFromEnergy(actualDischargeEnergy, capacity).percent;
        simSocPercent = Math.max(floorSoc.percent, simSocPercent - socDrop);

        const remainingLoadEnergy = desiredDischargeEnergy.subtract(actualDischargeEnergy);
        simGridPower = powerFromEnergy(remainingLoadEnergy, duration);
      } else {
        const surplusPower = Power.fromWatts(-netLoad.watts);
        const headroomEnergy = energyFromSoc(
          Percentage.fromPercent(Math.max(0, 100 - simSocPercent)),
          capacity,
        );
        const maxChargeEnergy = maxChargePowerSolar != null
          ? energyFromPower(maxChargePowerSolar, duration)
          : headroomEnergy;
        const surplusEnergy = energyFromPower(surplusPower, duration);
        const chargeEnergy = minEnergy(surplusEnergy, headroomEnergy, maxChargeEnergy);
        simulatedChargeFromSolar = powerFromEnergy(chargeEnergy, duration);

        const socGain = socFromEnergy(chargeEnergy, capacity).percent;
        simSocPercent = Math.min(100, simSocPercent + socGain);

        const exportEnergy = surplusEnergy.subtract(chargeEnergy);
        simGridPower = Power.fromWatts(-powerFromEnergy(exportEnergy, duration).watts);
      }

      const simGridEnergy = energyFromPower(simGridPower, duration);
      const simCost = computeGridEnergyCostEur(simGridEnergy, importPrice, feedInTariff);

      actualTotalCost += actualCost;
      simulatedTotalCost += simCost;
      const cashSavings = simCost - actualCost;
      cumulativeCashSavings += cashSavings;
      const relativeSocDiffPercent = (nextSocPercent - simSocPercent) - initialRelativeSocDiffPercent;
      const inventoryValue = energyDeltaFromSocPercent(relativeSocDiffPercent, capacity).kilowattHours * marginalPrice;

      intervals.push({
        timestamp: current.timestamp,
        end_timestamp: next.timestamp,
        duration_hours: durationHours,
        price_eur_per_kwh: priceEur,
        home_power_w: homePower.watts,
        site_demand_power_w: siteDemand.watts,
        synthetic_hidden_load_w: measuredSiteDemand == null ? hiddenLoad.watts : 0,
        solar_power_w: solarPower.watts,
        actual_grid_power_w: actualGridPower.watts,
        actual_soc_percent: actualSocPercent,
        simulated_soc_start_percent: simulatedSocStartPercent,
        simulated_soc_percent: simSocPercent,
        simulated_grid_power_w: simGridPower.watts,
        actual_cost_eur: actualCost,
        simulated_cost_eur: simCost,
        cash_savings_eur: cashSavings,
        cumulative_cash_savings_eur: cumulativeCashSavings,
        inventory_value_eur: inventoryValue,
        cumulative_savings_eur: cumulativeCashSavings + inventoryValue,
        actual_charge_from_solar_w: actualChargeFromSolar.watts,
        actual_charge_from_grid_w: actualChargeFromGrid.watts,
        simulated_charge_from_solar_w: simulatedChargeFromSolar.watts,
      });
    }

    if (intervals.length === 0) {
      return this.emptyResult("No valid intervals in history");
    }
    const actualFinalSoc = history[history.length - 1].battery_soc_percent ?? simSocPercent;
    const simFinalSoc = simSocPercent;

    const socDiffPercent = (actualFinalSoc - simFinalSoc) - initialRelativeSocDiffPercent;
    const socDiffKwh = energyDeltaFromSocPercent(socDiffPercent, capacity).kilowattHours;
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
      simulated_start_soc_percent: Number.isFinite(options?.initialSimSocPercent)
        ? Number(options?.initialSimSocPercent)
        : firstSoc,
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

  protected loadLast24hHistory(): HistoryPoint[] {
    const records = this.storage.listHistory(500);
    const allPoints = normalizeHistoryList(records.map((record) => record.payload));
    const cutoff = Date.now() - HOURS_24 * MS_PER_HOUR;
    return allPoints.filter((point) => new Date(point.timestamp).getTime() >= cutoff);
  }

  protected deriveMarginalDischargePrice(snapshot: SnapshotPayload, config: SimulationConfig): number {
    const gridFee = Number(config.price.grid_fee_eur_per_kwh ?? 0);
    const eras = snapshot.forecast_eras;
    const oracle = snapshot.oracle_entries;

    const eraPriceMap = new Map<string, number>();
    for (const era of eras) {
      const costSource = era.sources.find((source) => source.type === "cost");
      if (costSource) {
        eraPriceMap.set(era.era_id, costSource.payload.price_eur_per_kwh + gridFee);
      }
    }

    let totalWeightedPrice = 0;
    let totalDischargeWh = 0;
    for (const entry of oracle) {
      if (entry.strategy !== "auto") {
        continue;
      }
      const startSoc = entry.start_soc_percent ?? 0;
      const endSoc = entry.end_soc_percent ?? 0;
      if (endSoc >= startSoc) {
        continue;
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

    let totalHourPrice = 0;
    let totalHours = 0;
    for (const era of eras) {
      const hours = Number(era.duration_hours ?? 0);
      const costSource = era.sources.find((source) => source.type === "cost");
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

  protected emptyResult(reason: string): BacktestResult {
    this.logger.warn(`Backtest skipped: ${reason}`);
    return {
      generated_at: new Date().toISOString(),
      intervals: [],
      actual_total_cost_eur: 0,
      simulated_total_cost_eur: 0,
      simulated_start_soc_percent: 0,
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

function actualGridPowerOrFallback(
  rawGridPowerW: number | null | undefined,
  homePower: Power,
  solarPower: Power,
): Power {
  return rawGridPowerW != null && Number.isFinite(rawGridPowerW)
    ? Power.fromWatts(rawGridPowerW)
    : homePower.subtract(solarPower);
}

function minEnergy(first: Energy, ...rest: Energy[]): Energy {
  let min = first;
  for (const candidate of rest) {
    if (candidate.wattHours < min.wattHours) {
      min = candidate;
    }
  }
  return min;
}
