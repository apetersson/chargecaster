import type {
  ForecastEra,
  ForecastSourcePayload,
  HistoryPoint,
  OracleEntry,
} from "../../types";
import { TimeSlot } from "@chargecaster/domain";

import { DEFAULT_POWER_BOUNDS, DEFAULT_PRICE_BOUNDS, DEFAULT_SLOT_DURATION_MS } from "./constants";
import type { AxisBounds, DerivedEra, ProjectionPoint, TimeRangeMs } from "./types";

export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export const parseTimestamp = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : null;
};

export const toHistoryPoint = (
  timestamp: string,
  value: number | null | undefined,
): ProjectionPoint | null => {
  if (!isFiniteNumber(value)) {
    return null;
  }

  const time = parseTimestamp(timestamp);
  if (time === null) {
    return null;
  }

  return {x: time, y: value, source: "history"};
};

export const addPoint = (target: ProjectionPoint[], point: ProjectionPoint | null): void => {
  if (!point) {
    return;
  }
  const last = target[target.length - 1];
  if (last && last.x === point.x && last.y === point.y && last.source === point.source) {
    return;
  }
  target.push(point);
};

export const pushGapPoint = (target: ProjectionPoint[], time: number | null | undefined): void => {
  if (typeof time !== "number" || !Number.isFinite(time)) {
    return;
  }
  const last = target[target.length - 1];
  if (last && Number.isNaN(last.y) && last.x === time) {
    return;
  }
  target.push({x: time, y: Number.NaN, source: "gap"});
};

export const buildOracleLookup = (entries: OracleEntry[]): Map<string, OracleEntry> => {
  const lookup = new Map<string, OracleEntry>();
  for (const entry of entries) {
    if (!entry || entry.era_id.length === 0) {
      continue;
    }
    lookup.set(entry.era_id, entry);
    const timestamp = parseTimestamp(entry.era_id);
    if (timestamp !== null) {
      lookup.set(String(timestamp), entry);
    }
  }
  return lookup;
};

export const resolveOracleEntry = (
  era: ForecastEra,
  lookup: Map<string, OracleEntry>,
): OracleEntry | undefined => {
  if (era.era_id.length > 0) {
    const direct = lookup.get(era.era_id);
    if (direct) {
      return direct;
    }
    const normalizedEraId = parseTimestamp(era.era_id);
    if (normalizedEraId !== null) {
      const byEraIdTimestamp = lookup.get(String(normalizedEraId));
      if (byEraIdTimestamp) {
        return byEraIdTimestamp;
      }
    }
  }

  const startTimestamp = parseTimestamp(era.start);
  if (startTimestamp !== null) {
    const byStart = lookup.get(String(startTimestamp));
    if (byStart) {
      return byStart;
    }
  }

  return undefined;
};

export const derivePowerFromEnergy = (
  energyWh: number | null | undefined,
  durationHours?: number | null,
): number | null => {
  if (!isFiniteNumber(energyWh)) {
    return null;
  }
  const hours = typeof durationHours === "number" && durationHours > 0 ? durationHours : 1;
  if (hours <= 0) {
    return null;
  }
  const power = energyWh / hours;
  return Number.isFinite(power) ? power : null;
};

export const extractCostPrice = (era: ForecastEra): number | null => {
  const costSource = era.sources.find(
    (source): source is Extract<ForecastSourcePayload, { type: "cost" }> => source.type === "cost",
  );
  if (!costSource) {
    return null;
  }
  return costSource.payload.price_with_fee_ct_per_kwh ?? costSource.payload.price_ct_per_kwh ?? null;
};

export const extractSolarAverageWatts = (era: ForecastEra, slot: TimeSlot | null): number | null => {
  const solarSource = era.sources.find(
    (source): source is Extract<ForecastSourcePayload, { type: "solar" }> => source.type === "solar",
  );
  if (!solarSource) {
    return null;
  }
  const energyWh = solarSource.payload.energy_wh;
  const durationHours = slot?.duration.hours ?? null;
  if (durationHours && durationHours > 0) {
    return solarSource.payload.average_power_w ?? energyWh / durationHours;
  }
  return solarSource.payload.average_power_w ?? null;
};

export const buildFutureEras = (forecast: ForecastEra[], oracleEntries: OracleEntry[]): DerivedEra[] => {
  const oracleLookup = buildOracleLookup(oracleEntries);

  const now = Date.now();
  const derived: DerivedEra[] = [];
  for (const era of forecast) {
    const startMs = parseTimestamp(era.start);
    if (startMs === null) {
      continue;
    }
    const rawEndMs = parseTimestamp(era.end);
    const endMs = rawEndMs ?? startMs + DEFAULT_SLOT_DURATION_MS;
    if (endMs <= Math.max(startMs, now)) {
      continue;
    }
    let slot: TimeSlot;
    try {
      slot = TimeSlot.fromDates(new Date(startMs), new Date(endMs));
    } catch (error) {
      void error;
      continue;
    }
    const price = extractCostPrice(era);
    const solarAverage = extractSolarAverageWatts(era, slot);
    const oracle = resolveOracleEntry(era, oracleLookup);

    derived.push({
      era,
      oracle,
      slot,
      startMs,
      endMs,
      priceCtPerKwh: price,
      solarAverageW: solarAverage,
    });
  }

  return derived.sort((a, b) => a.startMs - b.startMs);
};

export const sortChronologically = (points: ProjectionPoint[]): ProjectionPoint[] =>
  points.sort((a, b) => a.x - b.x);

export const buildCombinedSeries = (
  historySeries: ProjectionPoint[],
  forecastSeries: ProjectionPoint[],
): ProjectionPoint[] => {
  const past = sortChronologically([...historySeries]);
  const future = sortChronologically([...forecastSeries]);

  if (!past.length) {
    return future;
  }
  if (!future.length) {
    return past;
  }

  const combined: ProjectionPoint[] = [...past];
  const gapTime = future[0].x;
  combined.push({x: gapTime, y: Number.NaN, source: "gap"});
  combined.push(...future);
  return combined;
};

export const findTimeRangeMs = (
  ...series: ProjectionPoint[][]
): TimeRangeMs => {
  let min: number | null = null;
  let max: number | null = null;
  for (const points of series) {
    for (const point of points) {
      const value = point.x;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        continue;
      }
      min = min === null ? value : Math.min(min, value);
      max = max === null ? value : Math.max(max, value);
    }
  }
  return {min, max};
};

export const computeBounds = (
  points: ProjectionPoint[],
  fallback: { min: number; max: number },
): AxisBounds => {
  let dataMin: number | null = null;
  let dataMax: number | null = null;

  for (const point of points) {
    const value = point.y;
    if (!Number.isFinite(value)) {
      continue;
    }
    dataMin = dataMin === null ? value : Math.min(dataMin, value);
    dataMax = dataMax === null ? value : Math.max(dataMax, value);
  }

  if (dataMin === null || dataMax === null) {
    return {...fallback, dataMin: null, dataMax: null};
  }

  let min = dataMin;
  let max = dataMax;

  const PADDING_FACTOR = 0.0;
  if (min === max) {
    const padding = Math.max(Math.abs(min) * PADDING_FACTOR, 1);
    min -= padding;
    max += padding;
  } else {
    const padding = Math.max((max - min) * PADDING_FACTOR, Number.EPSILON);
    min -= padding;
    max += padding;
  }

  if (min > dataMin) {
    min = dataMin;
  }
  if (max < dataMax) {
    max = dataMax;
  }

  return {min, max, dataMin, dataMax};
};

export const includeZeroInBounds = (bounds: AxisBounds): AxisBounds => {
  const min = Math.min(bounds.min, 0);
  const max = Math.max(bounds.max, 0);
  if (min === bounds.min && max === bounds.max) {
    return bounds;
  }
  return {...bounds, min, max};
};

export const ensureBounds = (
  powerSeries: ProjectionPoint[],
  priceSeries: ProjectionPoint[],
): { power: AxisBounds; price: AxisBounds } => {
  const power = includeZeroInBounds(computeBounds(powerSeries, DEFAULT_POWER_BOUNDS));
  const price = includeZeroInBounds(computeBounds(priceSeries, DEFAULT_PRICE_BOUNDS));
  return {power, price};
};

export const computeTimeRangeMs = (
  socSeries: ProjectionPoint[],
  gridSeries: ProjectionPoint[],
  solarSeries: ProjectionPoint[],
  priceSeries: ProjectionPoint[],
): TimeRangeMs => findTimeRangeMs(socSeries, gridSeries, solarSeries, priceSeries);

export const attachHistoryIntervals = (
  historyPoints: ProjectionPoint[],
  futureStart: number | undefined,
): void => {
  const fallbackStart = (current: ProjectionPoint) =>
    typeof futureStart === "number" ? futureStart : current.x + DEFAULT_SLOT_DURATION_MS;

  for (let i = 0; i < historyPoints.length; i += 1) {
    const current = historyPoints[i];
    const next = historyPoints[i + 1];
    const rawEnd = next?.x ?? fallbackStart(current);
    current.xEnd = rawEnd > current.x ? rawEnd : current.x + DEFAULT_SLOT_DURATION_MS;
  }
};

// (unused helpers removed)

export const resolvePriceValue = (entry: HistoryPoint): number | null => {
  const cents =
    entry.price_ct_per_kwh ??
    (typeof entry.price_eur_per_kwh === "number" ? entry.price_eur_per_kwh * 100 : null);
  return cents;
};
