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

interface PreparedComputation {
  state: ComputationState;
  feedInPrice: EnergyPrice;
  combined: SortedHistoryPoint[];
  windowStartMs: number;
  latestTimestampMs: number;
  windowHours: number;
}

interface IntervalComputation {
  startMs: number;
  endMs: number;
  duration: Duration;
  importPrice: EnergyPrice;
  costSmart: number;
  costDumb: number;
  gridPowerSmart: Power;
  gridPowerDumb: Power;
  socPrev: Percentage;
  socCurr: Percentage;
  dumbSocBefore: Percentage;
  dumbSocAfter: Percentage;
  importEnergy: Energy;
  exportEnergy: Energy;
  gridEnergySmart: Energy;
}

function prepareComputation(
  kind: "savings" | "series",
  config: SimulationConfig,
  rawHistory: HistoryPoint[],
  options: BacktestSavingsOptions,
): PreparedComputation | null {
  const {battery, price} = config;
  const capacityValue = toFiniteNumber(battery.capacity_kwh) ?? null;
  if (capacityValue === null || capacityValue <= 0) {
    computationLogger.warn(`Backtest ${kind} aborted: missing or invalid battery capacity`);
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
    computationLogger.verbose(`Backtest ${kind} aborted: unable to resolve reference timestamp`);
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
      `Backtest ${kind} aborted: insufficient history (usable_points=${combined.length})`,
    );
    return null;
  }

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

  return {
    state,
    feedInPrice,
    combined,
    windowStartMs,
    latestTimestampMs,
    windowHours,
  };
}

function primeState(entry: SortedHistoryPoint, state: ComputationState): void {
  const entrySoc = parseSoc(entry.battery_soc_percent);
  if (entrySoc) {
    state.dumbSoc = entrySoc;
  }
  const entryPrice = resolvePrice(entry);
  if (entryPrice) {
    state.lastPrice = entryPrice;
  }
}

function evaluateInterval(
  previous: SortedHistoryPoint,
  current: SortedHistoryPoint,
  state: ComputationState,
  feedInPrice: EnergyPrice,
): IntervalComputation | null {
  const deltaMs = current.__ts - previous.__ts;
  if (!(deltaMs > 0)) {
    return null;
  }
  const intervalDuration = Duration.fromMilliseconds(deltaMs);
  if (intervalDuration.milliseconds === 0) {
    return null;
  }

  const socPrev = parseSoc(previous.battery_soc_percent);
  const socCurr = parseSoc(current.battery_soc_percent);
  if (!socPrev || !socCurr) {
    return null;
  }

  const gridPowerW = toFiniteNumber(previous.grid_power_w);
  if (gridPowerW === null) {
    return null;
  }

  const solarPowerW = toFiniteNumber(previous.solar_power_w) ?? 0;
  const observedHomePowerW = toFiniteNumber(previous.home_power_w);

  let intervalPrice = resolvePrice(previous);
  intervalPrice ??= resolvePrice(current);
  intervalPrice ??= state.lastPrice;
  if (!intervalPrice) {
    return null;
  }
  state.lastPrice = intervalPrice;

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

  const dumbSocBefore = state.dumbSoc ?? socPrev;

  const remainingCapacityEnergy = state.capacity.scale(1 - dumbSocBefore.ratio);
  const chargeEnergy = Energy.fromKilowattHours(Math.min(
    solarSurplusEnergy.kilowattHours,
    remainingCapacityEnergy.kilowattHours,
    chargeLimitEnergy ? Math.max(0, chargeLimitEnergy.kilowattHours) : Number.POSITIVE_INFINITY,
  ));
  solarSurplusEnergy = Energy.fromKilowattHours(
    Math.max(0, solarSurplusEnergy.kilowattHours - chargeEnergy.kilowattHours),
  );

  let interimSocRatio = dumbSocBefore.ratio + (
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
  const dumbSocAfter = Percentage.fromRatio(finalSocRatio);
  state.dumbSoc = dumbSocAfter;

  const importEnergy = remainingLoadEnergy;
  const exportEnergy = solarSurplusEnergy;
  let costDumb = 0;
  if (importEnergy.kilowattHours > 0) {
    costDumb += intervalPrice.costFor(importEnergy);
  }
  if (exportEnergy.kilowattHours > 0) {
    costDumb -= feedInPrice.costFor(exportEnergy);
  }

  const gridEnergyDumb = Energy.fromKilowattHours(
    importEnergy.kilowattHours - exportEnergy.kilowattHours,
  );
  const gridPowerDumb = gridEnergyDumb.per(intervalDuration);

  return {
    startMs: previous.__ts,
    endMs: current.__ts,
    duration: intervalDuration,
    importPrice: intervalPrice,
    costSmart,
    costDumb,
    gridPowerSmart: gridPower,
    gridPowerDumb,
    socPrev,
    socCurr,
    dumbSocBefore,
    dumbSocAfter,
    importEnergy,
    exportEnergy,
    gridEnergySmart: gridEnergy,
  };
}

function iterateIntervals(
  prepared: PreparedComputation,
  callback: (interval: IntervalComputation) => void,
): { intervalCount: number; windowStartUsed: number | null } {
  const {combined, windowStartMs, state, feedInPrice} = prepared;
  let previous: SortedHistoryPoint | null = null;
  let intervalCount = 0;
  let windowStartUsed: number | null = null;

  for (const entry of combined) {
    if (entry.__ts < windowStartMs) {
      primeState(entry, state);
      previous = entry;
      continue;
    }

    if (!previous || previous.__ts < windowStartMs) {
      primeState(entry, state);
      previous = entry;
      continue;
    }

    const evaluation = evaluateInterval(previous, entry, state, feedInPrice);
    if (!evaluation) {
      previous = entry;
      continue;
    }

    intervalCount += 1;
    windowStartUsed = windowStartUsed === null
      ? evaluation.startMs
      : Math.min(windowStartUsed, evaluation.startMs);
    callback(evaluation);
    previous = entry;
  }

  return {intervalCount, windowStartUsed};
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
  const prepared = prepareComputation("savings", config, rawHistory, options);
  if (!prepared) {
    return null;
  }

  computationLogger.log(
    `Backtest savings computation started (windowHours=${prepared.windowHours}, points=${prepared.combined.length})`,
  );

  let actualCostEur = 0;
  let dumbCostEur = 0;
  let actualStartSoc: Percentage | undefined;
  let actualEndSoc: Percentage | undefined;
  let dumbStartSoc: Percentage | undefined;
  let dumbEndSoc: Percentage | undefined;

  const {intervalCount, windowStartUsed} = iterateIntervals(prepared, (interval) => {
    actualCostEur += interval.costSmart;
    dumbCostEur += interval.costDumb;

    actualStartSoc ??= interval.socPrev;
    actualEndSoc = interval.socCurr;

    dumbStartSoc ??= interval.dumbSocBefore;
    dumbEndSoc = interval.dumbSocAfter;
  });

  if (intervalCount === 0) {
    computationLogger.verbose("Backtest savings aborted: no intervals within window");
    return null;
  }

  const valuationPriceValue = toFiniteNumber(options.endValuationPriceEurPerKwh);
  let valuationAdjustment = 0;
  if (
    valuationPriceValue !== null &&
    actualStartSoc !== undefined && actualEndSoc !== undefined &&
    dumbStartSoc !== undefined && dumbEndSoc !== undefined
  ) {
    const valuationPrice = EnergyPrice.fromEurPerKwh(valuationPriceValue);
    const actualDeltaEnergy = prepared.state.capacity.scale(actualEndSoc.ratio - actualStartSoc.ratio);
    const dumbDeltaEnergy = prepared.state.capacity.scale(dumbEndSoc.ratio - dumbStartSoc.ratio);
    valuationAdjustment = valuationPrice.costFor(actualDeltaEnergy.subtract(dumbDeltaEnergy));
  }

  const savingsEur = dumbCostEur - actualCostEur + valuationAdjustment;
  const windowStartIso = new Date(windowStartUsed ?? prepared.windowStartMs).toISOString();
  const windowEndIso = new Date(prepared.latestTimestampMs).toISOString();

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
  const prepared = prepareComputation("series", config, rawHistory, options);
  if (!prepared) {
    return null;
  }

  computationLogger.log(
    `Backtest series computation started (windowHours=${prepared.windowHours}, points=${prepared.combined.length})`,
  );

  const points: BacktestSeriesPoint[] = [];
  let cumulativeCostSavingsEur = 0;

  const {windowStartUsed} = iterateIntervals(prepared, (interval) => {
    cumulativeCostSavingsEur += interval.costDumb - interval.costSmart;

    const energyDelta = prepared.state.capacity.scale(
      interval.socCurr.ratio - interval.dumbSocAfter.ratio,
    );
    const m2mAdjustmentEur = interval.importPrice.costFor(energyDelta);
    const cumulativeSavingsEur = cumulativeCostSavingsEur + m2mAdjustmentEur;

    const point: BacktestSeriesPoint = {
      start: new Date(interval.startMs).toISOString(),
      end: new Date(interval.endMs).toISOString(),
      price_ct_per_kwh: interval.importPrice.ctPerKwh,
      price_eur_per_kwh: interval.importPrice.eurPerKwh,
      grid_power_smart_w: interval.gridPowerSmart.watts,
      grid_power_dumb_w: interval.gridPowerDumb.watts,
      soc_smart_percent: interval.socCurr.percent,
      soc_dumb_percent: interval.dumbSocAfter.percent,
      cost_smart_eur: interval.costSmart,
      cost_dumb_eur: interval.costDumb,
      savings_eur: interval.costDumb - interval.costSmart,
      savings_cum_eur: cumulativeSavingsEur,
    };

    points.push(point);
  });

  if (!points.length) {
    computationLogger.verbose("Backtest series aborted: no data points generated");
    return null;
  }

  const generatedAt = new Date(prepared.latestTimestampMs).toISOString();
  const windowStartIso = new Date(windowStartUsed ?? prepared.windowStartMs).toISOString();
  const windowEndIso = new Date(prepared.latestTimestampMs).toISOString();
  computationLogger.log(
    `Backtest series complete: points=${points.length}, window_start=${windowStartIso}, window_end=${windowEndIso}`,
  );
  return { generated_at: generatedAt, window_start: windowStartIso, window_end: windowEndIso, points };
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
