import { Inject, Injectable, Logger } from "@nestjs/common";

import {
  type BacktestSeriesPoint,
  type BacktestSeriesResponse,
  Duration,
  Energy,
  EnergyPrice,
  type HistoryPoint,
  parseTemporal,
  Percentage,
  Power,
  type SimulationConfig,
} from "@chargecaster/domain";
import { StorageService } from "../storage/storage.service";

const DEFAULT_WINDOW_HOURS = 24;
const FALLBACK_HISTORY_LIMIT = 500;
const computationLogger = new Logger("BacktestComputation");

export interface BacktestSavingsOptions {
  history?: HistoryPoint[];
  extraEntries?: HistoryPoint[];
  referenceTimestamp?: string | Date | null;
  windowHours?: number;
  historyLimit?: number;
  importPriceFallbackEurPerKwh?: number | null;
  endValuationPriceEurPerKwh?: number | null;
}

export interface BacktestSavingsResult {
  savingsEur: number;
  actualCostEur: number;
  dumbCostEur: number;
  intervalCount: number;
  windowStart: string;
  windowEnd: string;
}

interface SortedHistoryPoint extends HistoryPoint {
  __ts: number;
}

interface ComputationState {
  lastPrice: EnergyPrice | null;
  dumbSoc: Percentage | null;
  capacity: Energy;
  floorSoc: Percentage;
  maxChargePower: Power | null;
  maxSolarChargePower: Power | null;
  maxDischargePower: Power | null;
}

function toFiniteNumber(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  return Number.isFinite(value) ? value : null;
}

function resolvePrice(point: HistoryPoint | null | undefined): EnergyPrice | null {
  if (!point) {
    return null;
  }
  const priceEur = toFiniteNumber(point.price_eur_per_kwh);
  if (priceEur !== null) {
    return EnergyPrice.fromEurPerKwh(priceEur);
  }
  const priceCt = toFiniteNumber(point.price_ct_per_kwh);
  if (priceCt !== null) {
    return EnergyPrice.fromEurPerKwh(priceCt / 100);
  }
  return null;
}

function parseSoc(value: number | null | undefined): Percentage | null {
  const numeric = toFiniteNumber(value);
  if (numeric === null) {
    return null;
  }
  const bounded = Math.min(100, Math.max(0, numeric));
  return Percentage.fromPercent(bounded);
}

function parsePower(value: number | null | undefined): Power | null {
  const numeric = toFiniteNumber(value);
  if (numeric === null || numeric <= 0) {
    return null;
  }
  return Power.fromWatts(numeric);
}

function resolveTimestampMs(input: string | Date | number | null | undefined): number | null {
  const parsed = parseTemporal(input);
  if (!parsed) {
    return null;
  }
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : null;
}

export function computeBacktestedSavings(
  config: SimulationConfig,
  rawHistory: HistoryPoint[],
  options: BacktestSavingsOptions = {},
): BacktestSavingsResult | null {
  const {battery, price} = config;
  const capacityValue = toFiniteNumber(battery.capacity_kwh) ?? null;
  if (capacityValue === null || capacityValue <= 0) {
    computationLogger.warn("Backtest savings aborted: missing or invalid battery capacity");
    return null;
  }
  const capacity = Energy.fromKilowattHours(capacityValue);

  const floorSoc = parseSoc(battery.auto_mode_floor_soc ?? 0) ?? Percentage.zero();
  const maxChargePower = parsePower(battery.max_charge_power_w ?? null);
  const maxSolarChargePower = parsePower(battery.max_charge_power_solar_w ?? null);
  const maxDischargePower = parsePower(battery.max_discharge_power_w ?? null);

  const referenceTimestampMs = resolveTimestampMs(options.referenceTimestamp);
  const latestTimestampMs = referenceTimestampMs ?? (() => {
    let maxMs = Number.NEGATIVE_INFINITY;
    for (const entry of rawHistory) {
      const ts = resolveTimestampMs(entry.timestamp);
      if (ts !== null && ts > maxMs) {
        maxMs = ts;
      }
    }
    return Number.isFinite(maxMs) ? maxMs : null;
  })();

  if (latestTimestampMs === null) {
    computationLogger.verbose("Backtest savings aborted: unable to resolve reference timestamp");
    return null;
  }

  const windowHours = options.windowHours != null && options.windowHours > 0
    ? options.windowHours
    : DEFAULT_WINDOW_HOURS;
  const windowStartMs = latestTimestampMs - windowHours * 3_600_000;

  const combined = rawHistory
    .map<SortedHistoryPoint>((entry) => {
      const ts = resolveTimestampMs(entry.timestamp) ?? Number.NaN;
      return {
        ...entry,
        __ts: ts,
      };
    })
    .filter((entry) => Number.isFinite(entry.__ts))
    .sort((a, b) => a.__ts - b.__ts);

  if (combined.length < 2) {
    computationLogger.verbose(
      `Backtest savings aborted: insufficient history (usable_points=${combined.length})`,
    );
    return null;
  }

  computationLogger.log(
    `Backtest savings computation started (windowHours=${windowHours}, points=${combined.length})`,
  );

  const feedInTariffValue = Math.max(0, toFiniteNumber(price.feed_in_tariff_eur_per_kwh) ?? 0);
  const feedInPrice = EnergyPrice.fromEurPerKwh(feedInTariffValue);
  const importPriceFallbackValue = toFiniteNumber(options.importPriceFallbackEurPerKwh);
  const fallbackPrice = importPriceFallbackValue !== null
    ? EnergyPrice.fromEurPerKwh(importPriceFallbackValue)
    : null;

  const state: ComputationState = {
    lastPrice: fallbackPrice,
    dumbSoc: null,
    capacity,
    floorSoc,
    maxChargePower,
    maxSolarChargePower,
    maxDischargePower,
  };

  let previous: SortedHistoryPoint | null = null;
  let actualCostEur = 0;
  let dumbCostEur = 0;
  let intervalCount = 0;
  let windowStartUsed: number | null = null;
  let actualStartSoc: Percentage | null = null;
  let actualEndSoc: Percentage | null = null;
  let dumbStartSoc: Percentage | null = null;
  let dumbEndSoc: Percentage | null = null;

  for (const entry of combined) {
    if (entry.__ts < windowStartMs) {
      previous = entry;
      const entrySoc = parseSoc(entry.battery_soc_percent);
      if (entrySoc) {
        state.dumbSoc = entrySoc;
      }
      const entryPrice = resolvePrice(entry);
      if (entryPrice) {
        state.lastPrice = entryPrice;
      }
      continue;
    }

    if (!previous || previous.__ts < windowStartMs) {
      previous = entry;
      const entrySoc = parseSoc(entry.battery_soc_percent);
      if (entrySoc) {
        state.dumbSoc = entrySoc;
      }
      const entryPrice = resolvePrice(entry);
      if (entryPrice) {
        state.lastPrice = entryPrice;
      }
      continue;
    }

    const deltaMs = entry.__ts - previous.__ts;
    if (!(deltaMs > 0)) {
      previous = entry;
      continue;
    }
    const intervalDuration = Duration.fromMilliseconds(deltaMs);
    if (intervalDuration.milliseconds === 0) {
      previous = entry;
      continue;
    }

    const socPrev = parseSoc(previous.battery_soc_percent);
    const socCurr = parseSoc(entry.battery_soc_percent);
    if (!socPrev || !socCurr) {
      previous = entry;
      continue;
    }

    const gridPowerW = toFiniteNumber(previous.grid_power_w);
    if (gridPowerW === null) {
      previous = entry;
      continue;
    }
    const solarPowerW = toFiniteNumber(previous.solar_power_w) ?? 0;
    const observedHomePowerW = toFiniteNumber(previous.home_power_w);

    let intervalPrice = resolvePrice(previous);
    intervalPrice ??= resolvePrice(entry);
    intervalPrice ??= state.lastPrice;
    if (!intervalPrice) {
      previous = entry;
      continue;
    }
    state.lastPrice = intervalPrice;

    actualStartSoc ??= socPrev;
    actualEndSoc = socCurr;

    const gridPower = Power.fromWatts(gridPowerW);
    const solarPower = Power.fromWatts(Math.max(0, solarPowerW));
    const observedHomePower = observedHomePowerW !== null
      ? Power.fromWatts(Math.max(0, observedHomePowerW))
      : null;

    const socDeltaRatio = socCurr.ratio - socPrev.ratio;
    const batteryEnergyDelta = state.capacity.scale(socDeltaRatio);
    const batteryPower = batteryEnergyDelta.per(intervalDuration);

    const derivedHouseLoadPower = Power.fromWatts(
      Math.max(0, gridPower.watts + solarPower.watts - batteryPower.watts),
    );
    const housePower = observedHomePower ?? derivedHouseLoadPower;

    const houseEnergy = housePower.forDuration(intervalDuration);
    const solarEnergy = solarPower.forDuration(intervalDuration);
    const gridEnergy = gridPower.forDuration(intervalDuration);

    const costSmart = gridEnergy.kilowattHours >= 0
      ? intervalPrice.costFor(gridEnergy)
      : feedInPrice.costFor(gridEnergy);
    actualCostEur += costSmart;

    state.dumbSoc ??= socPrev;
    const dumbSoc = state.dumbSoc;

    dumbStartSoc ??= dumbSoc;

    const solarToLoadKwh = Math.min(houseEnergy.kilowattHours, solarEnergy.kilowattHours);
    let remainingLoadEnergy = Energy.fromKilowattHours(
      Math.max(0, houseEnergy.kilowattHours - solarToLoadKwh),
    );
    let solarSurplusEnergy = Energy.fromKilowattHours(
      Math.max(0, solarEnergy.kilowattHours - solarToLoadKwh),
    );

    const chargeLimitEnergy = state.maxSolarChargePower
      ? state.maxSolarChargePower.forDuration(intervalDuration)
      : null;
    const dischargeLimitEnergy = state.maxDischargePower
      ? state.maxDischargePower.forDuration(intervalDuration)
      : null;

    const remainingCapacityEnergy = state.capacity.scale(1 - dumbSoc.ratio);
    const chargeEnergy = Energy.fromKilowattHours(Math.min(
      solarSurplusEnergy.kilowattHours,
      remainingCapacityEnergy.kilowattHours,
      chargeLimitEnergy ? Math.max(0, chargeLimitEnergy.kilowattHours) : Number.POSITIVE_INFINITY,
    ));
    solarSurplusEnergy = Energy.fromKilowattHours(
      Math.max(0, solarSurplusEnergy.kilowattHours - chargeEnergy.kilowattHours),
    );

    let interimSocRatio = dumbSoc.ratio + (
      state.capacity.kilowattHours > 0
        ? chargeEnergy.kilowattHours / state.capacity.kilowattHours
        : 0
    );
    interimSocRatio = Math.min(1, interimSocRatio);

    const availableDischargeEnergy = state.capacity.scale(
      Math.max(0, interimSocRatio - state.floorSoc.ratio),
    );
    const dischargeEnergy = Energy.fromKilowattHours(Math.min(
      remainingLoadEnergy.kilowattHours,
      availableDischargeEnergy.kilowattHours,
      dischargeLimitEnergy ? Math.max(0, dischargeLimitEnergy.kilowattHours) : Number.POSITIVE_INFINITY,
    ));
    remainingLoadEnergy = Energy.fromKilowattHours(
      Math.max(0, remainingLoadEnergy.kilowattHours - dischargeEnergy.kilowattHours),
    );

    let finalSocRatio = interimSocRatio - (
      state.capacity.kilowattHours > 0
        ? dischargeEnergy.kilowattHours / state.capacity.kilowattHours
        : 0
    );
    finalSocRatio = Math.min(1, Math.max(state.floorSoc.ratio, finalSocRatio));
    state.dumbSoc = Percentage.fromRatio(finalSocRatio);
    dumbEndSoc = state.dumbSoc;

    const importEnergy = remainingLoadEnergy;
    const exportEnergy = solarSurplusEnergy;
    let costDumb = 0;
    if (importEnergy.kilowattHours > 0) {
      costDumb += intervalPrice.costFor(importEnergy);
    }
    if (exportEnergy.kilowattHours > 0) {
      costDumb -= feedInPrice.costFor(exportEnergy);
    }

    dumbCostEur += costDumb;
    intervalCount += 1;
    windowStartUsed = windowStartUsed === null ? previous.__ts : Math.min(windowStartUsed, previous.__ts);

    previous = entry;
  }

  if (intervalCount === 0) {
    computationLogger.verbose("Backtest savings aborted: no intervals within window");
    return null;
  }

  const valuationPriceValue = toFiniteNumber(options.endValuationPriceEurPerKwh);
  let valuationAdjustment = 0;
  if (
    valuationPriceValue !== null &&
    actualStartSoc && actualEndSoc &&
    dumbStartSoc && dumbEndSoc
  ) {
    const valuationPrice = EnergyPrice.fromEurPerKwh(valuationPriceValue);
    const actualDeltaEnergy = state.capacity.scale(actualEndSoc.ratio - actualStartSoc.ratio);
    const dumbDeltaEnergy = state.capacity.scale(dumbEndSoc.ratio - dumbStartSoc.ratio);
    valuationAdjustment = valuationPrice.costFor(actualDeltaEnergy.subtract(dumbDeltaEnergy));
  }

  const savingsEur = dumbCostEur - actualCostEur + valuationAdjustment;
  const windowStartIso = new Date(windowStartUsed ?? windowStartMs).toISOString();
  const windowEndIso = new Date(latestTimestampMs).toISOString();

  computationLogger.log(
    `Backtest savings complete: intervals=${intervalCount}, savings=${savingsEur.toFixed(2)} EUR`,
  );

  return {
    savingsEur,
    actualCostEur,
    dumbCostEur,
    intervalCount,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
  };
}

function computeBacktestSeries(
  config: SimulationConfig,
  rawHistory: HistoryPoint[],
  options: BacktestSavingsOptions = {},
): BacktestSeriesResponse | null {
  const {battery, price} = config;
  const capacityValue = toFiniteNumber(battery.capacity_kwh) ?? null;
  if (capacityValue === null || capacityValue <= 0) {
    computationLogger.warn("Backtest series aborted: missing or invalid battery capacity");
    return null;
  }
  const capacity = Energy.fromKilowattHours(capacityValue);

  const floorSoc = parseSoc(battery.auto_mode_floor_soc ?? 0) ?? Percentage.zero();
  const maxChargePower = parsePower(battery.max_charge_power_w ?? null);
  const maxSolarChargePower = parsePower(battery.max_charge_power_solar_w ?? null);
  const maxDischargePower = parsePower(battery.max_discharge_power_w ?? null);

  const referenceTimestampMs = resolveTimestampMs(options.referenceTimestamp);
  const latestTimestampMs = referenceTimestampMs ?? (() => {
    let maxMs = Number.NEGATIVE_INFINITY;
    for (const entry of rawHistory) {
      const ts = resolveTimestampMs(entry.timestamp);
      if (ts !== null && ts > maxMs) {
        maxMs = ts;
      }
    }
    return Number.isFinite(maxMs) ? maxMs : null;
  })();

  if (latestTimestampMs === null) {
    computationLogger.verbose("Backtest series aborted: unable to resolve reference timestamp");
    return null;
  }

  const windowHours = options.windowHours != null && options.windowHours > 0
    ? options.windowHours
    : DEFAULT_WINDOW_HOURS;
  const windowStartMs = latestTimestampMs - windowHours * 3_600_000;

  const combined = rawHistory
    .map<SortedHistoryPoint>((entry) => {
      const ts = resolveTimestampMs(entry.timestamp) ?? Number.NaN;
      return {
        ...entry,
        __ts: ts,
      };
    })
    .filter((entry) => Number.isFinite(entry.__ts))
    .sort((a, b) => a.__ts - b.__ts);

  if (combined.length < 2) {
    computationLogger.verbose(
      `Backtest series aborted: insufficient history (usable_points=${combined.length})`,
    );
    return null;
  }

  computationLogger.log(
    `Backtest series computation started (windowHours=${windowHours}, points=${combined.length})`,
  );

  const feedInTariffValue = Math.max(0, toFiniteNumber(price.feed_in_tariff_eur_per_kwh) ?? 0);
  const feedInPrice = EnergyPrice.fromEurPerKwh(feedInTariffValue);
  const importPriceFallbackValue = toFiniteNumber(options.importPriceFallbackEurPerKwh);
  const fallbackPrice = importPriceFallbackValue !== null
    ? EnergyPrice.fromEurPerKwh(importPriceFallbackValue)
    : null;

  const state: ComputationState = {
    lastPrice: fallbackPrice,
    dumbSoc: null,
    capacity,
    floorSoc,
    maxChargePower,
    maxSolarChargePower,
    maxDischargePower,
  };

  let previous: SortedHistoryPoint | null = null;
  let windowStartUsed: number | null = null;
  const points: BacktestSeriesPoint[] = [];
  let cumulativeCostSavingsEur = 0;

  for (const entry of combined) {
    if (entry.__ts < windowStartMs) {
      previous = entry;
      const entrySoc = parseSoc(entry.battery_soc_percent);
      if (entrySoc) state.dumbSoc = entrySoc;
      const entryPrice = resolvePrice(entry);
      if (entryPrice) state.lastPrice = entryPrice;
      continue;
    }

    if (!previous || previous.__ts < windowStartMs) {
      previous = entry;
      const entrySoc = parseSoc(entry.battery_soc_percent);
      if (entrySoc) state.dumbSoc = entrySoc;
      const entryPrice = resolvePrice(entry);
      if (entryPrice) state.lastPrice = entryPrice;
      continue;
    }

    const deltaMs = entry.__ts - previous.__ts;
    if (!(deltaMs > 0)) {
      previous = entry;
      continue;
    }
    const intervalDuration = Duration.fromMilliseconds(deltaMs);
    if (intervalDuration.milliseconds === 0) {
      previous = entry;
      continue;
    }

    const socPrev = parseSoc(previous.battery_soc_percent);
    const socCurr = parseSoc(entry.battery_soc_percent);
    if (!socPrev || !socCurr) {
      previous = entry;
      continue;
    }
    const gridPowerW = toFiniteNumber(previous.grid_power_w);
    if (gridPowerW === null) {
      previous = entry;
      continue;
    }
    const solarPowerW = toFiniteNumber(previous.solar_power_w) ?? 0;
    const observedHomePowerW = toFiniteNumber(previous.home_power_w);

    let intervalPrice = resolvePrice(previous);
    intervalPrice ??= resolvePrice(entry);
    intervalPrice ??= state.lastPrice;
    if (!intervalPrice) {
      previous = entry;
      continue;
    }
    state.lastPrice = intervalPrice;

    const importPrice = intervalPrice;

    const gridPower = Power.fromWatts(gridPowerW);
    const solarPower = Power.fromWatts(Math.max(0, solarPowerW));
    const observedHomePower = observedHomePowerW !== null
      ? Power.fromWatts(Math.max(0, observedHomePowerW))
      : null;

    const socDeltaRatio = socCurr.ratio - socPrev.ratio;
    const batteryEnergyDelta = state.capacity.scale(socDeltaRatio);
    const batteryPower = batteryEnergyDelta.per(intervalDuration);

    const derivedHouseLoadPower = Power.fromWatts(Math.max(0, gridPower.watts + solarPower.watts - batteryPower.watts));
    const housePower = observedHomePower ?? derivedHouseLoadPower;

    const houseEnergy = housePower.forDuration(intervalDuration);
    const solarEnergy = solarPower.forDuration(intervalDuration);
    const gridEnergy = gridPower.forDuration(intervalDuration);

    const costSmart = gridEnergy.kilowattHours >= 0
      ? importPrice.costFor(gridEnergy)
      : feedInPrice.costFor(gridEnergy);

    state.dumbSoc ??= socPrev;
    const dumbSoc = state.dumbSoc;

    const solarToLoadKwh = Math.min(houseEnergy.kilowattHours, solarEnergy.kilowattHours);
    let remainingLoadEnergy = Energy.fromKilowattHours(Math.max(0, houseEnergy.kilowattHours - solarToLoadKwh));
    let solarSurplusEnergy = Energy.fromKilowattHours(Math.max(0, solarEnergy.kilowattHours - solarToLoadKwh));

    const chargeLimitEnergy = state.maxSolarChargePower
      ? state.maxSolarChargePower.forDuration(intervalDuration)
      : null;
    const dischargeLimitEnergy = state.maxDischargePower
      ? state.maxDischargePower.forDuration(intervalDuration)
      : null;

    const remainingCapacityEnergy = state.capacity.scale(1 - dumbSoc.ratio);
    const chargeEnergy = Energy.fromKilowattHours(Math.min(
      solarSurplusEnergy.kilowattHours,
      remainingCapacityEnergy.kilowattHours,
      chargeLimitEnergy ? Math.max(0, chargeLimitEnergy.kilowattHours) : Number.POSITIVE_INFINITY,
    ));
    solarSurplusEnergy = Energy.fromKilowattHours(Math.max(0, solarSurplusEnergy.kilowattHours - chargeEnergy.kilowattHours));

    let interimSocRatio = dumbSoc.ratio + (
      state.capacity.kilowattHours > 0
        ? chargeEnergy.kilowattHours / state.capacity.kilowattHours
        : 0
    );
    interimSocRatio = Math.min(1, interimSocRatio);

    const availableDischargeEnergy = state.capacity.scale(Math.max(0, interimSocRatio - state.floorSoc.ratio));
    const dischargeEnergy = Energy.fromKilowattHours(Math.min(
      remainingLoadEnergy.kilowattHours,
      availableDischargeEnergy.kilowattHours,
      dischargeLimitEnergy ? Math.max(0, dischargeLimitEnergy.kilowattHours) : Number.POSITIVE_INFINITY,
    ));
    remainingLoadEnergy = Energy.fromKilowattHours(Math.max(0, remainingLoadEnergy.kilowattHours - dischargeEnergy.kilowattHours));

    let finalSocRatio = interimSocRatio - (
      state.capacity.kilowattHours > 0
        ? dischargeEnergy.kilowattHours / state.capacity.kilowattHours
        : 0
    );
    finalSocRatio = Math.min(1, Math.max(state.floorSoc.ratio, finalSocRatio));
    state.dumbSoc = Percentage.fromRatio(finalSocRatio);
    const updatedDumbSoc = state.dumbSoc;

    const importEnergy = remainingLoadEnergy;
    const exportEnergy = solarSurplusEnergy;
    let costDumb = 0;
    if (importEnergy.kilowattHours > 0) {
      costDumb += importPrice.costFor(importEnergy);
    }
    if (exportEnergy.kilowattHours > 0) {
      costDumb -= feedInPrice.costFor(exportEnergy);
    }

    const gridEnergyDumb = Energy.fromKilowattHours(importEnergy.kilowattHours - exportEnergy.kilowattHours);
    const gridPowerDumb = gridEnergyDumb.per(intervalDuration);

    cumulativeCostSavingsEur += (costDumb - costSmart);

    const energyDelta = state.capacity.scale(socCurr.ratio - updatedDumbSoc.ratio);
    const m2mAdjustmentEur = importPrice.costFor(energyDelta);
    const cumulativeSavingsEur = cumulativeCostSavingsEur + m2mAdjustmentEur;

    const point: BacktestSeriesPoint = {
      start: new Date(previous.__ts).toISOString(),
      end: new Date(entry.__ts).toISOString(),
      price_ct_per_kwh: importPrice.ctPerKwh,
      price_eur_per_kwh: importPrice.eurPerKwh,
      grid_power_smart_w: gridPower.watts,
      grid_power_dumb_w: gridPowerDumb.watts,
      soc_smart_percent: socCurr.percent,
      soc_dumb_percent: updatedDumbSoc.percent,
      cost_smart_eur: costSmart,
      cost_dumb_eur: costDumb,
      savings_eur: costDumb - costSmart,
      savings_cum_eur: cumulativeSavingsEur,
    };

    points.push(point);
    windowStartUsed = windowStartUsed === null ? previous.__ts : Math.min(windowStartUsed, previous.__ts);
    previous = entry;
  }

  if (!points.length) {
    computationLogger.verbose("Backtest series aborted: no data points generated");
    return null;
  }

  const generatedAt = new Date(latestTimestampMs).toISOString();
  const windowStartIso = new Date(windowStartUsed ?? windowStartMs).toISOString();
  const windowEndIso = new Date(latestTimestampMs).toISOString();
  computationLogger.log(
    `Backtest series complete: points=${points.length}, window_start=${windowStartIso}, window_end=${windowEndIso}`,
  );
  return {generated_at: generatedAt, window_start: windowStartIso, window_end: windowEndIso, points};
}

@Injectable()
export class BacktestSavingsService {
  private readonly logger = new Logger(BacktestSavingsService.name);

  constructor(@Inject(StorageService) private readonly storage: StorageService) {
  }

  calculate(
    config: SimulationConfig,
    options: BacktestSavingsOptions = {},
  ): BacktestSavingsResult | null {
    const limit = options.historyLimit ?? FALLBACK_HISTORY_LIMIT;
    const baseHistory = options.history ?? this.storage.listHistory(limit).map((record) => record.payload);
    const extraEntries = options.extraEntries ?? [];
    const combined = baseHistory.concat(extraEntries);
    this.logger.log(
      `Calculating backtest savings (history=${baseHistory.length}, extra=${extraEntries.length}, limit=${limit})`,
    );
    try {
      const result = computeBacktestedSavings(config, combined, {
        ...options,
        history: undefined,
        extraEntries: undefined,
      });
      if (result) {
        this.logger.log(
          `Backtest savings computed: intervals=${result.intervalCount}, savings=${result.savingsEur.toFixed(2)} EUR`,
        );
      } else {
        this.logger.verbose("Backtest savings unavailable: insufficient data returned");
      }
      return result;
    } catch (error) {
      this.logger.warn(`Failed to compute backtested savings: ${String(error)}`);
      return null;
    }
  }

  buildSeries(
    config: SimulationConfig,
    options: BacktestSavingsOptions = {},
  ): BacktestSeriesResponse | null {
    const limit = options.historyLimit ?? FALLBACK_HISTORY_LIMIT;
    const baseHistory = options.history ?? this.storage.listHistory(limit).map((record) => record.payload);
    const extraEntries = options.extraEntries ?? [];
    const combined = baseHistory.concat(extraEntries);
    this.logger.log(
      `Building backtest series (history=${baseHistory.length}, extra=${extraEntries.length}, limit=${limit})`,
    );
    try {
      const result = computeBacktestSeries(config, combined, {
        ...options,
        history: undefined,
        extraEntries: undefined,
      });
      if (result) {
        this.logger.log(
          `Backtest series generated: points=${result.points.length}, window=${result.window_start}→${result.window_end}`,
        );
      } else {
        this.logger.verbose("Backtest series unavailable: insufficient data returned");
      }
      return result;
    } catch (error) {
      this.logger.warn(`Failed to compute backtest series: ${String(error)}`);
      return null;
    }
  }
}
