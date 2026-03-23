import type { HistoryPoint } from "../../types";

import { DEFAULT_POWER_BOUNDS, DEFAULT_PRICE_BOUNDS, DEFAULT_SLOT_DURATION_MS, GAP_THRESHOLD_MS } from "./constants";
import type { AxisBounds, ProjectionPoint, TimeRangeMs } from "./types";

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
  const last = target.at(-1);
  if (last && last.x === point.x && last.y === point.y && last.source === point.source) {
    return;
  }
  target.push(point);
};

export const pushGapPoint = (target: ProjectionPoint[], time: number | null | undefined): void => {
  if (typeof time !== "number" || !Number.isFinite(time)) {
    return;
  }
  const last = target.at(-1);
  if (last && Number.isNaN(last.y) && last.x === time) {
    return;
  }
  target.push({x: time, y: Number.NaN, source: "gap"});
};

export const sortChronologically = (points: ProjectionPoint[]): ProjectionPoint[] =>
  points.sort((a, b) => a.x - b.x);

export const buildCombinedSeries = (
  historySeries: ProjectionPoint[],
  forecastSeries: ProjectionPoint[],
  options?: { allowContinuous?: boolean },
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
  const firstFuture = future[0];
  const lastPast = past[past.length - 1];
  const delta = typeof firstFuture.x === "number" && typeof lastPast.x === "number"
    ? firstFuture.x - lastPast.x
    : Number.POSITIVE_INFINITY;
  const shouldAllowContinuous = options?.allowContinuous ?? false;
  if (!shouldAllowContinuous || !Number.isFinite(delta) || delta > GAP_THRESHOLD_MS) {
    combined.push({x: firstFuture.x, y: Number.NaN, source: "gap"});
  }
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
    if (Number.isFinite(value)) {
      dataMin = dataMin === null ? value : Math.min(dataMin, value);
      dataMax = dataMax === null ? value : Math.max(dataMax, value);
    }
    const feedInValue = point.feedInY;
    if (typeof feedInValue === "number" && Number.isFinite(feedInValue)) {
      dataMin = dataMin === null ? feedInValue : Math.min(dataMin, feedInValue);
      dataMax = dataMax === null ? feedInValue : Math.max(dataMax, feedInValue);
    }
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
  const fallbackStart = (currentX: number) =>
    typeof futureStart === "number" ? futureStart : currentX + DEFAULT_SLOT_DURATION_MS;

  for (let i = 0; i < historyPoints.length; i += 1) {
    const current = historyPoints[i];
    const currentX = Number(current.x);
    if (!Number.isFinite(currentX)) {
      continue;
    }
    const next = i + 1 < historyPoints.length ? historyPoints[i + 1] : null;
    const nextX = next ? Number(next.x) : Number.NaN;
    const rawEnd = Number.isFinite(nextX) ? nextX : fallbackStart(currentX);
    current.xEnd = rawEnd >= currentX ? rawEnd : currentX + DEFAULT_SLOT_DURATION_MS;
  }
};

// (unused helpers removed)

export const resolvePriceValue = (entry: HistoryPoint): number | null => {
  const cents =
    entry.price_ct_per_kwh ??
    (typeof entry.price_eur_per_kwh === "number" ? entry.price_eur_per_kwh * 100 : null);
  return cents;
};
