import { Inject, Injectable, Logger } from "@nestjs/common";
import type { HistoryPoint, SimulationConfig, SnapshotPayload } from "@chargecaster/domain";
import {
  Duration,
  Energy,
  Percentage,
  Power,
  TimeSlot,
  energyDeltaFromSocPercent,
  energyFromPower,
  energyFromSoc,
  inferBatteryPowerFromSocDelta,
  powerFromEnergy,
  socFromEnergy,
} from "@chargecaster/domain";
import { Money } from "../../../packages/domain/src/money";
import { computeGridEnergyCost } from "../../../packages/domain/src/battery-math";
import { EnergyPrice } from "../../../packages/domain/src/price";
import { StorageService } from "../storage/storage.service";
import { DynamicPriceConfigService } from "../config/dynamic-price-config.service";
import { normalizeHistoryList } from "./history.serializer";
import type {
  BacktestInterval,
  BacktestIntervalPayload,
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
    @Inject(DynamicPriceConfigService) private readonly dynamicPriceConfigService: DynamicPriceConfigService,
  ) {}

  run(snapshot: SnapshotPayload, config: SimulationConfig, options?: BuildDailyBacktestOptions): BacktestResult {
    const history = this.loadLast24hHistory();
    return this.runForHistory(history, config, {
      configDocument: options?.configDocument,
      snapshot,
    });
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
      configDocument: options?.configDocument,
      snapshot: options?.snapshot,
      marginalPrice: marginalPrice ?? undefined,
      initialSimSocPercent: options?.initialSimSocPercent,
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
    const gridFee = resolveGridFee(config);
    const nextDayPoints = this.loadUtcDayHistory(this.nextUtcDate(date));
    return (nextDayPoints.length >= 2
      ? this.deriveMarginalPriceFromHistory(nextDayPoints, gridFee)
      : null) ?? options?.fallbackMarginalPrice ?? null;
  }

  protected deriveMarginalPriceFromHistory(points: HistoryPoint[], gridFee: EnergyPrice): number | null {
    const samples: { price: EnergyPrice; duration: Duration }[] = [];
    for (let i = 0; i < points.length - 1; i += 1) {
      const point = points[i];
      if (point.price_eur_per_kwh == null || !Number.isFinite(point.price_eur_per_kwh)) {
        continue;
      }
      const t0 = new Date(point.timestamp).getTime();
      const t1 = new Date(points[i + 1].timestamp).getTime();
      const duration = Duration.fromMilliseconds(t1 - t0);
      if (duration.milliseconds <= 0 || duration.hours > 2) {
        continue;
      }
      samples.push({
        price: EnergyPrice.fromEurPerKwh(point.price_eur_per_kwh).withAdditionalFee(gridFee.eurPerKwh),
        duration,
      });
    }
    return samples.length > 0 ? EnergyPrice.weightedAverageByDuration(samples).eurPerKwh : null;
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
      configDocument?: BuildDailyBacktestOptions["configDocument"];
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
    const gridFee = resolveGridFee(config);
    const feedInTariffByInterval = options?.configDocument
      ? this.dynamicPriceConfigService.buildFeedInTariffScheduleFromHistory(options.configDocument, config, history)
      : null;
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
    const intervals: BacktestInterval[] = [];
    let actualTotalCost = Money.zero();
    let simulatedTotalCost = Money.zero();
    let cumulativeCashSavings = Money.zero();

    for (let i = 0; i < history.length - 1; i += 1) {
      const current = history[i];
      const next = history[i + 1];

      const t0 = new Date(current.timestamp).getTime();
      const t1 = new Date(next.timestamp).getTime();
      const intervalMs = t1 - t0;
      if (intervalMs <= 0 || intervalMs > MS_PER_HOUR * 2) {
        continue;
      }
      const duration = Duration.fromMilliseconds(intervalMs);

      const priceEur = Number(current.price_eur_per_kwh ?? 0);
      const importPrice = EnergyPrice.fromEurPerKwh(priceEur).withAdditionalFee(gridFee.eurPerKwh);
      const feedInTariff = EnergyPrice.fromEurPerKwh(
        Number(feedInTariffByInterval?.[i] ?? config.price.feed_in_tariff_eur_per_kwh ?? 0),
      );

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
      const actualCost = computeGridEnergyCost(actualGridEnergy, importPrice, feedInTariff);

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
      const simCost = computeGridEnergyCost(simGridEnergy, importPrice, feedInTariff);

      actualTotalCost = actualTotalCost.add(actualCost);
      simulatedTotalCost = simulatedTotalCost.add(simCost);
      const cashSavings = simCost.subtract(actualCost);
      cumulativeCashSavings = cumulativeCashSavings.add(cashSavings);
      const relativeSocDiffPercent = (nextSocPercent - simSocPercent) - initialRelativeSocDiffPercent;
      const inventoryValue = EnergyPrice.fromEurPerKwh(marginalPrice).costFor(
        energyDeltaFromSocPercent(relativeSocDiffPercent, capacity),
      );

      intervals.push({
        slot: TimeSlot.fromDates(new Date(current.timestamp), new Date(next.timestamp)),
        price: EnergyPrice.fromEurPerKwh(priceEur),
        homePower,
        siteDemandPower: siteDemand,
        syntheticHiddenLoad: measuredSiteDemand == null ? hiddenLoad : Power.zero(),
        solarPower,
        actualGridPower,
        actualSoc,
        simulatedSocStart: Percentage.fromPercent(simulatedSocStartPercent),
        simulatedSoc: Percentage.fromPercent(simSocPercent),
        simulatedGridPower: simGridPower,
        actualCost,
        simulatedCost: simCost,
        cashSavings,
        cumulativeCashSavings,
        inventoryValue,
        cumulativeSavings: cumulativeCashSavings.add(inventoryValue),
        actualChargeFromSolar,
        actualChargeFromGrid,
        simulatedChargeFromSolar,
      });
    }

    if (intervals.length === 0) {
      return this.emptyResult("No valid intervals in history");
    }
    const actualFinalSoc = history[history.length - 1].battery_soc_percent ?? simSocPercent;
    const simFinalSoc = simSocPercent;

    const socDiffPercent = (actualFinalSoc - simFinalSoc) - initialRelativeSocDiffPercent;
    const socValueAdj = EnergyPrice.fromEurPerKwh(marginalPrice).costFor(
      energyDeltaFromSocPercent(socDiffPercent, capacity),
    );

    const adjustedActualCost = actualTotalCost.subtract(socValueAdj);
    const adjustedSimCost = simulatedTotalCost;

    const firstTs = new Date(history[0].timestamp).getTime();
    const lastTs = new Date(history[history.length - 1].timestamp).getTime();
    const spanHours = (lastTs - firstTs) / MS_PER_HOUR;

    this.logger.log(
      `Backtest complete: ${intervals.length} intervals, span=${spanHours.toFixed(1)}h, ` +
      `actual=${actualTotalCost.eur.toFixed(3)}EUR, simulated=${simulatedTotalCost.eur.toFixed(3)}EUR, ` +
      `SOC adj=${socValueAdj.eur.toFixed(3)}EUR (marginal=${EnergyPrice.fromEurPerKwh(marginalPrice).ctPerKwh.toFixed(1)}ct/kWh), ` +
      `savings=${adjustedSimCost.subtract(adjustedActualCost).eur.toFixed(3)}EUR`,
    );

    return {
      generated_at: new Date().toISOString(),
      intervals: intervals.map(serializeBacktestInterval),
      actual_total_cost_eur: actualTotalCost.eur,
      simulated_total_cost_eur: simulatedTotalCost.eur,
      simulated_start_soc_percent: Number.isFinite(options?.initialSimSocPercent)
        ? Number(options?.initialSimSocPercent)
        : firstSoc,
      actual_final_soc_percent: actualFinalSoc,
      simulated_final_soc_percent: simFinalSoc,
      soc_value_adjustment_eur: socValueAdj.eur,
      adjusted_actual_cost_eur: adjustedActualCost.eur,
      adjusted_simulated_cost_eur: adjustedSimCost.eur,
      savings_eur: adjustedSimCost.subtract(adjustedActualCost).eur,
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
    const gridFee = resolveGridFee(config);
    const eras = snapshot.forecast_eras;
    const oracle = snapshot.oracle_entries;

    const eraPriceMap = new Map<string, EnergyPrice>();
    for (const era of eras) {
      const costSource = era.sources.find((source) => source.type === "cost");
      if (costSource) {
        eraPriceMap.set(
          era.era_id,
          EnergyPrice.fromEurPerKwh(costSource.payload.price_eur_per_kwh).withAdditionalFee(gridFee.eurPerKwh),
        );
      }
    }

    let totalWeightedValue = Money.zero();
    let totalDischargeEnergy = Energy.zero();
    for (const entry of oracle) {
      if (entry.strategy !== "auto" && entry.strategy !== "limit") {
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
      const dischargeEnergy = Energy.fromWattHours(Math.abs(entry.grid_energy_wh ?? 0));
      if (dischargeEnergy.wattHours <= 0) {
        continue;
      }
      totalWeightedValue = totalWeightedValue.add(price.costFor(dischargeEnergy));
      totalDischargeEnergy = totalDischargeEnergy.add(dischargeEnergy);
    }

    if (totalDischargeEnergy.wattHours > 0) {
      return totalWeightedValue.eur / totalDischargeEnergy.kilowattHours;
    }

    const durationSamples: { price: EnergyPrice; duration: Duration }[] = [];
    for (const era of eras) {
      const hours = Number(era.duration_hours ?? 0);
      const costSource = era.sources.find((source) => source.type === "cost");
      if (costSource && hours > 0) {
        durationSamples.push({
          price: EnergyPrice.fromEurPerKwh(costSource.payload.price_eur_per_kwh).withAdditionalFee(gridFee.eurPerKwh),
          duration: Duration.fromHours(hours),
        });
      }
    }
    if (durationSamples.length > 0) {
      return EnergyPrice.weightedAverageByDuration(durationSamples).eurPerKwh;
    }

    const snapshotPrice = snapshot.price_snapshot_eur_per_kwh;
    return (typeof snapshotPrice === "number" && Number.isFinite(snapshotPrice))
      ? EnergyPrice.fromEurPerKwh(snapshotPrice).withAdditionalFee(gridFee.eurPerKwh).eurPerKwh
      : gridFee.eurPerKwh;
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

function serializeBacktestInterval(interval: BacktestInterval): BacktestIntervalPayload {
  return {
    timestamp: interval.slot.start.toISOString(),
    end_timestamp: interval.slot.end.toISOString(),
    duration_hours: interval.slot.duration.hours,
    price_eur_per_kwh: interval.price.eurPerKwh,
    home_power_w: interval.homePower.watts,
    site_demand_power_w: interval.siteDemandPower.watts,
    synthetic_hidden_load_w: interval.syntheticHiddenLoad.watts,
    solar_power_w: interval.solarPower.watts,
    actual_grid_power_w: interval.actualGridPower.watts,
    actual_soc_percent: interval.actualSoc.percent,
    simulated_soc_start_percent: interval.simulatedSocStart.percent,
    simulated_soc_percent: interval.simulatedSoc.percent,
    simulated_grid_power_w: interval.simulatedGridPower.watts,
    actual_cost_eur: interval.actualCost.eur,
    simulated_cost_eur: interval.simulatedCost.eur,
    cash_savings_eur: interval.cashSavings.eur,
    cumulative_cash_savings_eur: interval.cumulativeCashSavings.eur,
    inventory_value_eur: interval.inventoryValue.eur,
    cumulative_savings_eur: interval.cumulativeSavings.eur,
    actual_charge_from_solar_w: interval.actualChargeFromSolar.watts,
    actual_charge_from_grid_w: interval.actualChargeFromGrid.watts,
    simulated_charge_from_solar_w: interval.simulatedChargeFromSolar.watts,
  };
}

function resolveGridFee(config: SimulationConfig): EnergyPrice {
  const gridFeeEurPerKwh = config.price.grid_fee_eur_per_kwh;
  return EnergyPrice.fromEurPerKwh(gridFeeEurPerKwh ?? 0);
}
