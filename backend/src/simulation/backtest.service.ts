import { Inject, Injectable, Logger } from "@nestjs/common";

import type { BacktestSeriesPoint, BacktestSeriesResponse, HistoryPoint, SimulationConfig } from "./types";
import { StorageService } from "../storage/storage.service";

const DEFAULT_WINDOW_HOURS = 24;
const FALLBACK_HISTORY_LIMIT = 500;

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
  lastPriceEur: number | null;
  dumbSoc: number | null;
  capacityKwh: number;
  floorSoc: number;
  maxChargePowerW: number | null;
  maxSolarChargePowerW: number | null;
  maxDischargePowerW: number | null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
}

function resolvePriceEur(point: HistoryPoint | null | undefined): number | null {
  if (!point) {
    return null;
  }
  const priceEur = toFiniteNumber(point.price_eur_per_kwh ?? null);
  if (priceEur !== null) {
    return priceEur;
  }
  const priceCt = toFiniteNumber(point.price_ct_per_kwh ?? null);
  if (priceCt !== null) {
    return priceCt / 100;
  }
  return null;
}

function clampSoc(value: number | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
}

function resolveTimestampMs(input: string | Date | number | null | undefined): number | null {
  if (input == null) {
    return null;
  }
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : null;
  }
  if (input instanceof Date) {
    const time = input.getTime();
    return Number.isFinite(time) ? time : null;
  }
  const time = Date.parse(input);
  return Number.isFinite(time) ? time : null;
}

export function computeBacktestedSavings(
  config: SimulationConfig,
  rawHistory: HistoryPoint[],
  options: BacktestSavingsOptions = {},
): BacktestSavingsResult | null {
  const capacityKwh = toFiniteNumber(config?.battery?.capacity_kwh) ?? null;
  if (capacityKwh === null || capacityKwh <= 0) {
    return null;
  }
  const floorSoc = clampSoc(config?.battery?.auto_mode_floor_soc ?? 0) ?? 0;
  const maxChargePowerW = toFiniteNumber(config?.battery?.max_charge_power_w) ?? null;
  const maxSolarChargePowerW = toFiniteNumber(config?.battery?.max_charge_power_solar_w) ?? null;
  const maxDischargePowerW = toFiniteNumber(config?.battery?.max_discharge_power_w) ?? null;

  const referenceTimestampMs = resolveTimestampMs(options.referenceTimestamp ?? null);
  const latestTimestampMs = referenceTimestampMs ?? (() => {
    let maxMs = Number.NEGATIVE_INFINITY;
    for (const entry of rawHistory) {
      const ts = resolveTimestampMs(entry?.timestamp ?? null);
      if (ts !== null && ts > maxMs) {
        maxMs = ts;
      }
    }
    return Number.isFinite(maxMs) ? maxMs : null;
  })();

  if (latestTimestampMs === null) {
    return null;
  }

  const windowHours = options.windowHours && Number.isFinite(options.windowHours) && options.windowHours > 0
    ? options.windowHours
    : DEFAULT_WINDOW_HOURS;
  const windowStartMs = latestTimestampMs - windowHours * 3_600_000;

  const combined = rawHistory
    .filter((entry) => entry && typeof entry === "object")
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
    return null;
  }

  const feedInTariff = Math.max(0, toFiniteNumber(config?.price?.feed_in_tariff_eur_per_kwh) ?? 0);
  const importPriceFallback = options.importPriceFallbackEurPerKwh ?? null;

  const state: ComputationState = {
    lastPriceEur: importPriceFallback,
    dumbSoc: null,
    capacityKwh,
    floorSoc,
    maxChargePowerW,
    maxSolarChargePowerW,
    maxDischargePowerW,
  };

  let previous: SortedHistoryPoint | null = null;
  let actualCostEur = 0;
  let dumbCostEur = 0;
  let intervalCount = 0;
  let windowStartUsed: number | null = null;
  let actualStartSoc: number | null = null;
  let actualEndSoc: number | null = null;
  let dumbStartSoc: number | null = null;
  let dumbEndSoc: number | null = null;

  for (const entry of combined) {
    if (entry.__ts < windowStartMs) {
      previous = entry;
      const entrySoc = clampSoc(entry.battery_soc_percent ?? null);
      if (entrySoc !== null) {
        state.dumbSoc = entrySoc;
      }
      const entryPrice = resolvePriceEur(entry);
      if (entryPrice !== null) {
        state.lastPriceEur = entryPrice;
      }
      continue;
    }

    if (!previous || previous.__ts < windowStartMs) {
      previous = entry;
      const entrySoc = clampSoc(entry.battery_soc_percent ?? null);
      if (entrySoc !== null) {
        state.dumbSoc = entrySoc;
      }
      const entryPrice = resolvePriceEur(entry);
      if (entryPrice !== null) {
        state.lastPriceEur = entryPrice;
      }
      continue;
    }

    const deltaMs = entry.__ts - previous.__ts;
    if (!(deltaMs > 0)) {
      previous = entry;
      continue;
    }
    const durationHours = deltaMs / 3_600_000;
    if (!Number.isFinite(durationHours) || durationHours <= 0) {
      previous = entry;
      continue;
    }

    const socPrev = clampSoc(previous.battery_soc_percent ?? null);
    const socCurr = clampSoc(entry.battery_soc_percent ?? null);
    if (socPrev === null || socCurr === null) {
      previous = entry;
      continue;
    }

    const gridPowerW = toFiniteNumber(previous.grid_power_w ?? null);
    if (gridPowerW === null) {
      previous = entry;
      continue;
    }
    const solarPowerW = toFiniteNumber(previous.solar_power_w ?? null) ?? 0;
    const observedHomePowerW = toFiniteNumber(previous.home_power_w ?? null);

    let intervalPriceEur = resolvePriceEur(previous);
    intervalPriceEur ??= resolvePriceEur(entry) ?? state.lastPriceEur;

    if (intervalPriceEur === null) {
      previous = entry;
      continue;
    }

    state.lastPriceEur = intervalPriceEur;

    // Track actual SoC delta within the window
    actualStartSoc ??= socPrev;
    actualEndSoc = socCurr;

    const batteryPowerW = ((socCurr - socPrev) / 100) * (state.capacityKwh / durationHours) * 1000;
    const derivedHouseLoadW = Math.max(0, gridPowerW + solarPowerW - batteryPowerW);
    const houseLoadW = Math.max(0, observedHomePowerW ?? derivedHouseLoadW);
    const houseLoadEnergyKwh = (houseLoadW / 1000) * durationHours;
    const solarEnergyKwh = (Math.max(0, solarPowerW) / 1000) * durationHours;

    const gridEnergyKwh = (gridPowerW / 1000) * durationHours;
    if (gridEnergyKwh >= 0) {
      actualCostEur += gridEnergyKwh * intervalPriceEur;
    } else {
      actualCostEur += gridEnergyKwh * feedInTariff;
    }

    state.dumbSoc ??= socPrev;
    if (state.dumbSoc === null) {
      previous = entry;
      continue;
    }

    // Track baseline (dumb) start SoC once we have it
    dumbStartSoc ??= state.dumbSoc;

    const solarToLoadKwh = Math.min(houseLoadEnergyKwh, solarEnergyKwh);
    let remainingLoadKwh = houseLoadEnergyKwh - solarToLoadKwh;
    let solarSurplusKwh = solarEnergyKwh - solarToLoadKwh;

    const solarChargeLimitW = typeof state.maxSolarChargePowerW === "number" && state.maxSolarChargePowerW > 0
      ? state.maxSolarChargePowerW
      : null;
    const chargeLimitKwh = solarChargeLimitW !== null ? (solarChargeLimitW / 1000) * durationHours : Number.POSITIVE_INFINITY;
    const dischargeLimitW = typeof state.maxDischargePowerW === "number" && state.maxDischargePowerW > 0
      ? state.maxDischargePowerW
      : null;
    const dischargeLimitKwh = dischargeLimitW !== null ? (dischargeLimitW / 1000) * durationHours : Number.POSITIVE_INFINITY;

    const capacityRemainingKwh = Math.max(0, ((100 - state.dumbSoc) / 100) * state.capacityKwh);
    const chargeEnergyKwh = Math.min(solarSurplusKwh, capacityRemainingKwh, chargeLimitKwh);
    solarSurplusKwh -= chargeEnergyKwh;

    let interimSoc = state.dumbSoc + (chargeEnergyKwh / state.capacityKwh) * 100;
    if (!Number.isFinite(interimSoc)) {
      interimSoc = state.dumbSoc;
    }
    if (interimSoc > 100) {
      interimSoc = 100;
    }

    const availableDischargeKwh = Math.max(0, ((interimSoc - state.floorSoc) / 100) * state.capacityKwh);
    const dischargeEnergyKwh = Math.min(remainingLoadKwh, availableDischargeKwh, dischargeLimitKwh);
    remainingLoadKwh -= dischargeEnergyKwh;

    let finalSoc = interimSoc - (dischargeEnergyKwh / state.capacityKwh) * 100;
    if (!Number.isFinite(finalSoc)) {
      finalSoc = interimSoc;
    }
    if (finalSoc < state.floorSoc) {
      finalSoc = state.floorSoc;
    }
    if (finalSoc > 100) {
      finalSoc = 100;
    }
    state.dumbSoc = finalSoc;
    dumbEndSoc = state.dumbSoc;

    const importEnergyKwh = Math.max(0, remainingLoadKwh);
    const exportEnergyKwh = Math.max(0, solarSurplusKwh);

    dumbCostEur += importEnergyKwh * intervalPriceEur;
    dumbCostEur -= exportEnergyKwh * feedInTariff;

    intervalCount += 1;
    windowStartUsed = windowStartUsed === null ? previous.__ts : Math.min(windowStartUsed, previous.__ts);

    previous = entry;
  }

  if (intervalCount === 0) {
    return null;
  }

  // Apply inventory valuation adjustment if provided
  const valuationPrice = toFiniteNumber(options.endValuationPriceEurPerKwh ?? null);
  const aStart = toFiniteNumber(actualStartSoc);
  const aEnd = toFiniteNumber(actualEndSoc);
  const dStart = toFiniteNumber(dumbStartSoc);
  const dEnd = toFiniteNumber(dumbEndSoc);
  let valuationAdjustment = 0;
  if (
    valuationPrice !== null &&
    aStart !== null && aEnd !== null &&
    dStart !== null && dEnd !== null
  ) {
    const actualDeltaKwh = ((aEnd - aStart) / 100) * capacityKwh;
    const dumbDeltaKwh = ((dEnd - dStart) / 100) * capacityKwh;
    valuationAdjustment = (actualDeltaKwh - dumbDeltaKwh) * valuationPrice;
  }

  const savingsEur = dumbCostEur - actualCostEur + valuationAdjustment;
  const windowStartIso = new Date(windowStartUsed ?? windowStartMs).toISOString();
  const windowEndIso = new Date(latestTimestampMs).toISOString();

  return {
    savingsEur,
    actualCostEur,
    dumbCostEur,
    intervalCount,
    windowStart: windowStartIso,
    windowEnd: windowEndIso,
  };
}

export function computeBacktestSeries(
  config: SimulationConfig,
  rawHistory: HistoryPoint[],
  options: BacktestSavingsOptions = {},
): BacktestSeriesResponse | null {
  const capacityKwh = toFiniteNumber(config?.battery?.capacity_kwh) ?? null;
  if (capacityKwh === null || capacityKwh <= 0) {
    return null;
  }
  const floorSoc = clampSoc(config?.battery?.auto_mode_floor_soc ?? 0) ?? 0;
  const maxChargePowerW = toFiniteNumber(config?.battery?.max_charge_power_w) ?? null;
  const maxSolarChargePowerW = toFiniteNumber(config?.battery?.max_charge_power_solar_w) ?? null;
  const maxDischargePowerW = toFiniteNumber(config?.battery?.max_discharge_power_w) ?? null;

  const referenceTimestampMs = resolveTimestampMs(options.referenceTimestamp ?? null);
  const latestTimestampMs = referenceTimestampMs ?? (() => {
    let maxMs = Number.NEGATIVE_INFINITY;
    for (const entry of rawHistory) {
      const ts = resolveTimestampMs(entry?.timestamp ?? null);
      if (ts !== null && ts > maxMs) {
        maxMs = ts;
      }
    }
    return Number.isFinite(maxMs) ? maxMs : null;
  })();
  if (latestTimestampMs === null) {
    return null;
  }
  const windowHours = options.windowHours && Number.isFinite(options.windowHours) && options.windowHours > 0
    ? options.windowHours
    : DEFAULT_WINDOW_HOURS;
  const windowStartMs = latestTimestampMs - windowHours * 3_600_000;

  const combined = rawHistory
    .filter((entry) => entry && typeof entry === "object")
    .map<SortedHistoryPoint>((entry) => ({...entry, __ts: resolveTimestampMs(entry.timestamp) ?? Number.NaN}))
    .filter((entry) => Number.isFinite(entry.__ts))
    .sort((a, b) => a.__ts - b.__ts);
  if (combined.length < 2) {
    return null;
  }

  const feedInTariff = Math.max(0, toFiniteNumber(config?.price?.feed_in_tariff_eur_per_kwh) ?? 0);
  const importPriceFallback = options.importPriceFallbackEurPerKwh ?? null;

  const state: ComputationState = {
    lastPriceEur: importPriceFallback,
    dumbSoc: null,
    capacityKwh,
    floorSoc,
    maxChargePowerW,
    maxSolarChargePowerW,
    maxDischargePowerW,
  };

  let previous: SortedHistoryPoint | null = null;
  let windowStartUsed: number | null = null;
  const points: BacktestSeriesPoint[] = [];
  let cumulativeCostSavingsEur = 0; // sum(cost_dumb - cost_smart)

  for (const entry of combined) {
    if (entry.__ts < windowStartMs) {
      previous = entry;
      const entrySoc = clampSoc(entry.battery_soc_percent ?? null);
      if (entrySoc !== null) state.dumbSoc = entrySoc;
      const entryPrice = resolvePriceEur(entry);
      if (entryPrice !== null) state.lastPriceEur = entryPrice;
      continue;
    }

    if (!previous || previous.__ts < windowStartMs) {
      previous = entry;
      const entrySoc = clampSoc(entry.battery_soc_percent ?? null);
      if (entrySoc !== null) state.dumbSoc = entrySoc;
      const entryPrice = resolvePriceEur(entry);
      if (entryPrice !== null) state.lastPriceEur = entryPrice;
      continue;
    }

    const deltaMs = entry.__ts - previous.__ts;
    if (!(deltaMs > 0)) {
      previous = entry;
      continue;
    }
    const durationHours = deltaMs / 3_600_000;
    if (!Number.isFinite(durationHours) || durationHours <= 0) {
      previous = entry;
      continue;
    }

    const socPrev = clampSoc(previous.battery_soc_percent ?? null);
    const socCurr = clampSoc(entry.battery_soc_percent ?? null);
    if (socPrev === null || socCurr === null) {
      previous = entry;
      continue;
    }
    const gridPowerW = toFiniteNumber(previous.grid_power_w ?? null);
    if (gridPowerW === null) {
      previous = entry;
      continue;
    }
    const solarPowerW = toFiniteNumber(previous.solar_power_w ?? null) ?? 0;
    const observedHomePowerW = toFiniteNumber(previous.home_power_w ?? null);

    let intervalPriceEur = resolvePriceEur(previous);
    intervalPriceEur ??= resolvePriceEur(entry) ?? state.lastPriceEur;
    if (intervalPriceEur === null) {
      previous = entry;
      continue;
    }
    state.lastPriceEur = intervalPriceEur;

    const batteryPowerW = ((socCurr - socPrev) / 100) * (state.capacityKwh / durationHours) * 1000;
    const derivedHouseLoadW = Math.max(0, gridPowerW + solarPowerW - batteryPowerW);
    const houseLoadW = Math.max(0, observedHomePowerW ?? derivedHouseLoadW);
    const houseLoadEnergyKwh = (houseLoadW / 1000) * durationHours;
    const solarEnergyKwh = (Math.max(0, solarPowerW) / 1000) * durationHours;

    // Actual (smart): take measured grid power
    const gridEnergySmartKwh = (gridPowerW / 1000) * durationHours;
    const costSmart = gridEnergySmartKwh >= 0
      ? gridEnergySmartKwh * intervalPriceEur
      : gridEnergySmartKwh * feedInTariff;

    // Dumb baseline: PV-first, no grid-charging, respect floor SOC & power caps
    state.dumbSoc ??= socPrev;
    if (state.dumbSoc === null) {
      previous = entry;
      continue;
    }

    const solarToLoadKwh = Math.min(houseLoadEnergyKwh, solarEnergyKwh);
    let remainingLoadKwh = houseLoadEnergyKwh - solarToLoadKwh;
    let solarSurplusKwh = solarEnergyKwh - solarToLoadKwh;

    const solarChargeLimitW = typeof state.maxSolarChargePowerW === "number" && state.maxSolarChargePowerW > 0
      ? state.maxSolarChargePowerW
      : null;
    const chargeLimitKwh = solarChargeLimitW !== null ? (solarChargeLimitW / 1000) * durationHours : Number.POSITIVE_INFINITY;
    const dischargeLimitW = typeof state.maxDischargePowerW === "number" && state.maxDischargePowerW > 0
      ? state.maxDischargePowerW
      : null;
    const dischargeLimitKwh = dischargeLimitW !== null ? (dischargeLimitW / 1000) * durationHours : Number.POSITIVE_INFINITY;

    const capacityRemainingKwh = Math.max(0, ((100 - state.dumbSoc) / 100) * state.capacityKwh);
    const chargeEnergyKwh = Math.min(solarSurplusKwh, capacityRemainingKwh, chargeLimitKwh);
    solarSurplusKwh -= chargeEnergyKwh;
    let interimSoc = state.dumbSoc + (chargeEnergyKwh / state.capacityKwh) * 100;
    if (!Number.isFinite(interimSoc)) interimSoc = state.dumbSoc;
    if (interimSoc > 100) interimSoc = 100;

    const availableDischargeKwh = Math.max(0, ((interimSoc - state.floorSoc) / 100) * state.capacityKwh);
    const dischargeEnergyKwh = Math.min(remainingLoadKwh, availableDischargeKwh, dischargeLimitKwh);
    remainingLoadKwh -= dischargeEnergyKwh;

    let finalSoc = interimSoc - (dischargeEnergyKwh / state.capacityKwh) * 100;
    if (!Number.isFinite(finalSoc)) finalSoc = interimSoc;
    if (finalSoc < state.floorSoc) finalSoc = state.floorSoc;
    if (finalSoc > 100) finalSoc = 100;
    state.dumbSoc = finalSoc;

    const importEnergyKwh = Math.max(0, remainingLoadKwh);
    const exportEnergyKwh = Math.max(0, solarSurplusKwh);
    const gridEnergyDumbKwh = importEnergyKwh - exportEnergyKwh;
    const costDumb = importEnergyKwh * intervalPriceEur - exportEnergyKwh * feedInTariff;

    cumulativeCostSavingsEur += (costDumb - costSmart);

    // Mark-to-market valuation for remaining inventory difference (smart vs dumb) at interval end.
    const energyDeltaKwh = ((socCurr - state.dumbSoc) / 100) * state.capacityKwh;
    const m2mAdjustmentEur = energyDeltaKwh * intervalPriceEur;
    const cumulativeSavingsEur = cumulativeCostSavingsEur + m2mAdjustmentEur;

    const point: BacktestSeriesPoint = {
      start: new Date(previous.__ts).toISOString(),
      end: new Date(entry.__ts).toISOString(),
      price_ct_per_kwh: intervalPriceEur * 100,
      price_eur_per_kwh: intervalPriceEur,
      grid_power_smart_w: gridPowerW,
      grid_power_dumb_w: (gridEnergyDumbKwh / durationHours) * 1000,
      soc_smart_percent: socCurr,
      soc_dumb_percent: state.dumbSoc,
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
    return null;
  }

  const generatedAt = new Date(latestTimestampMs).toISOString();
  const windowStartIso = new Date(windowStartUsed ?? windowStartMs).toISOString();
  const windowEndIso = new Date(latestTimestampMs).toISOString();
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
    try {
      return computeBacktestedSavings(config, combined, {
        ...options,
        history: undefined,
        extraEntries: undefined,
      });
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
    try {
      return computeBacktestSeries(config, combined, {
        ...options,
        history: undefined,
        extraEntries: undefined,
      });
    } catch (error) {
      this.logger.warn(`Failed to compute backtest series: ${String(error)}`);
      return null;
    }
  }
}
