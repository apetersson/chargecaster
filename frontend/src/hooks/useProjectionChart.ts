import { useEffect, useRef } from "react";
import {
  BarController,
  BarElement,
  Chart,
  Filler,
  Legend,
  LineController,
  LineElement,
  LinearScale,
  PointElement,
  ScatterController,
  TimeScale,
  Tooltip,
  type ChartDataset,
  type ChartOptions,
  type Plugin,
  type ScatterDataPoint,
  type ScriptableContext,
  type ScriptableLineSegmentContext,
} from "chart.js";
import "chartjs-adapter-date-fns";

import type { ForecastEra, HistoryPoint, OracleEntry, SnapshotSummary } from "../types";
import {
  dateTimeFormatter,
  numberFormatter,
  percentFormatter,
  timeFormatter,
} from "../utils/format";

Chart.register(
  BarController,
  BarElement,
  LineController,
  LineElement,
  ScatterController,
  PointElement,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  Filler,
);

type SeriesSource = "history" | "forecast" | "gap";

interface ProjectionPoint extends ScatterDataPoint {
  source: SeriesSource;
  xEnd?: number | null;
  isCurrentMarker?: boolean;
}

interface AxisBounds {
  min: number;
  max: number;
  dataMin: number | null;
  dataMax: number | null;
}

const HISTORY_BORDER = "rgba(100, 116, 139, 1)";
const HISTORY_POINT = "rgba(71, 85, 105, 1)";
const HISTORY_FILL = "rgba(100, 116, 139, 0.15)";
const SOC_BORDER = "#22c55e";
const SOC_FILL = "rgba(34, 197, 94, 0.15)";
const GRID_BORDER = "#f97316";
const GRID_FILL = "rgba(249, 115, 22, 0.15)";
const SOLAR_BORDER = "#facc15";
const SOLAR_FILL = "rgba(250, 204, 21, 0.2)";
const PRICE_BORDER = "#38bdf8";
const PRICE_FILL = "rgba(56, 189, 248, 0.15)";
const GRID_COLOR = "rgba(148, 163, 184, 0.25)";
const TICK_COLOR = "#64748b";
const LEGEND_COLOR = "#475569";
const GRID_MARKERS_LABEL = "Grid Power Markers";
const TARIFF_LABEL = "Tariff";
const PRICE_HISTORY_BAR_BG = "rgba(148, 163, 184, 0.3)";
const PRICE_HISTORY_BAR_BORDER = "rgba(100, 116, 139, 1)";
const DEFAULT_SLOT_DURATION_MS = 3_600_000;

const DEFAULT_SOC_BOUNDS = { min: 0, max: 100 };
const DEFAULT_POWER_BOUNDS = { min: -5000, max: 15000 };
const DEFAULT_PRICE_BOUNDS = { min: 0, max: 50 };

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const parseTimestamp = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : null;
};

const toHistoryPoint = (
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

  return { x: time, y: value, source: "history" };
};

const addPoint = (target: ProjectionPoint[], point: ProjectionPoint | null) => {
  if (!point) {
    return;
  }
  const last = target[target.length - 1];
  if (last && last.x === point.x && last.y === point.y && last.source === point.source) {
    return;
  }
  target.push(point);
};

const toNumeric = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.length > 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
};

const convertPriceToCents = (value: unknown, unit: unknown): number | null => {
  const numeric = toNumeric(value);
  if (numeric === null) {
    return null;
  }
  const unitStr = typeof unit === "string" ? unit.trim().toLowerCase() : "";
  if (!unitStr) {
    return numeric * 100;
  }
  if (unitStr.includes("ct") && unitStr.includes("/wh")) {
    return numeric * 1000;
  }
  if (unitStr.includes("ct") && unitStr.includes("kwh")) {
    return numeric;
  }
  if ((unitStr.includes("eur") || unitStr.includes("€/")) && unitStr.includes("mwh")) {
    return numeric / 10;
  }
  if ((unitStr.includes("eur") || unitStr.includes("€/")) && unitStr.includes("/wh")) {
    return numeric * 100000;
  }
  if ((unitStr.includes("eur") || unitStr.includes("€/")) && unitStr.includes("kwh")) {
    return numeric * 100;
  }
  if (unitStr.includes("ct")) {
    return numeric;
  }
  if (unitStr.includes("eur")) {
    return numeric * 100;
  }
  return numeric * 100;
};

const extractCostPrice = (era: ForecastEra): number | null => {
  for (const source of era.sources) {
    if (source.type !== "cost") {
      continue;
    }
    const payload = source.payload;
    if (!payload || typeof payload !== "object") {
      continue;
    }
    const record = payload;
    const centsWithFee =
      toNumeric(record.price_with_fee_ct_per_kwh) ?? toNumeric(record.total_price_ct_per_kwh);
    if (centsWithFee !== null) {
      return centsWithFee;
    }
    const cents = toNumeric(record.price_ct_per_kwh) ?? toNumeric(record.value_ct_per_kwh);
    if (cents !== null) {
      return cents;
    }
    const rawPrice = record.price ?? record.value;
    const rawUnit = record.unit ?? record.price_unit ?? record.value_unit;
    const price = convertPriceToCents(rawPrice, rawUnit);
    if (price !== null) {
      return price;
    }
  }
  return null;
};

const extractSolarAverageWatts = (era: ForecastEra, durationHours: number | null): number | null => {
  const solarSource = era.sources.find((source) => source.type === "solar");
  if (!solarSource) {
    return null;
  }
  const payload = solarSource.payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const record = payload;
  let energyKwh = toNumeric(record.energy_kwh);
  if (energyKwh === null) {
    const energyWh = toNumeric(record.energy_wh);
    if (energyWh !== null) {
      energyKwh = energyWh / 1000;
    }
  }
  if (energyKwh !== null && durationHours && durationHours > 0) {
    return (energyKwh / durationHours) * 1000;
  }
  const explicitPower =
    toNumeric(record.power_w) ??
    toNumeric(record.value) ??
    toNumeric(record.power);
  return explicitPower;
};

interface DerivedEra {
  era: ForecastEra;
  oracle?: OracleEntry;
  startMs: number;
  endMs: number;
  durationHours: number;
  priceCtPerKwh: number | null;
  solarAverageW: number | null;
}

const buildFutureEras = (forecast: ForecastEra[], oracleEntries: OracleEntry[]): DerivedEra[] => {
  const oracleMap = new Map<string, OracleEntry>();
  for (const entry of oracleEntries) {
    if (entry && typeof entry.era_id === "string") {
      oracleMap.set(entry.era_id, entry);
    }
  }

  const now = Date.now();
  const derived: DerivedEra[] = [];
  for (const era of forecast) {
    const startMs = parseTimestamp(era.start);
    if (startMs === null || startMs <= now) {
      continue;
    }
    const rawEndMs = parseTimestamp(era.end);
    const endMs = rawEndMs ?? startMs + DEFAULT_SLOT_DURATION_MS;
    if (endMs <= startMs) {
      continue;
    }
    const durationHours =
      typeof era.duration_hours === "number" && Number.isFinite(era.duration_hours)
        ? era.duration_hours
        : (endMs - startMs) / 3_600_000;
    const price = extractCostPrice(era);
    const solarAverage = extractSolarAverageWatts(era, durationHours);

    derived.push({
      era,
      oracle: era.era_id ? oracleMap.get(era.era_id) : undefined,
      startMs,
      endMs,
      durationHours,
      priceCtPerKwh: price,
      solarAverageW: solarAverage,
    });
  }

  return derived.sort((a, b) => a.startMs - b.startMs);
};

const sortChronologically = (points: ProjectionPoint[]) =>
  points.sort((a, b) => a.x - b.x);

const buildCombinedSeries = (
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
  combined.push({ x: gapTime, y: Number.NaN, source: "gap" });
  combined.push(...future);
  return combined;
};

const findTimeRange = (
  ...series: ProjectionPoint[][]
): { min: number | null; max: number | null } => {
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
  return { min, max };
};

const computeBounds = (
  points: ProjectionPoint[],
  fallback: { min: number; max: number },
): AxisBounds => {
  let dataMin: number | null = null;
  let dataMax: number | null = null;

  for (const point of points) {
    const value = point.y;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    dataMin = dataMin === null ? value : Math.min(dataMin, value);
    dataMax = dataMax === null ? value : Math.max(dataMax, value);
  }

  if (dataMin === null || dataMax === null) {
    return { ...fallback, dataMin: null, dataMax: null };
  }

  let min = dataMin;
  let max = dataMax;

  if (min === max) {
    const padding = Math.max(Math.abs(min) * 0.1, 1);
    min -= padding;
    max += padding;
  } else {
    const padding = Math.max((max - min) * 0.1, Number.EPSILON);
    min -= padding;
    max += padding;
  }

  if (min > dataMin) {
    min = dataMin;
  }
  if (max < dataMax) {
    max = dataMax;
  }

  return { min, max, dataMin, dataMax };
};

const includeZeroInBounds = (bounds: AxisBounds): AxisBounds => {
  const min = Math.min(bounds.min, 0);
  const max = Math.max(bounds.max, 0);
  if (min === bounds.min && max === bounds.max) {
    return bounds;
  }
  return { ...bounds, min, max };
};

const resolveInitialSoc = (
  summary: SnapshotSummary | null,
  historyPoints: ProjectionPoint[],
): number => {
  if (summary && isFiniteNumber(summary.current_soc_percent)) {
    return summary.current_soc_percent;
  }
  const lastHistory = historyPoints.length ? historyPoints[historyPoints.length - 1].y : null;
  if (typeof lastHistory === "number" && Number.isFinite(lastHistory)) {
    return lastHistory;
  }
  if (summary && isFiniteNumber(summary.next_step_soc_percent)) {
    return summary.next_step_soc_percent;
  }
  return 0;
};

const buildSocSeries = (
  history: HistoryPoint[],
  futureEras: DerivedEra[],
  summary: SnapshotSummary | null,
): { series: ProjectionPoint[]; currentMarker: ProjectionPoint | null } => {
  const historyPoints = history
    .map((entry) => toHistoryPoint(entry.timestamp, entry.battery_soc_percent))
    .filter((point): point is ProjectionPoint => point !== null);

  const summarySoc = summary && isFiniteNumber(summary.current_soc_percent)
    ? summary.current_soc_percent
    : null;
  const summaryTimestamp = summary?.timestamp ? parseTimestamp(summary.timestamp) : null;
  if (summarySoc !== null && summaryTimestamp !== null) {
    const summaryPoint: ProjectionPoint = {
      x: summaryTimestamp,
      y: summarySoc,
      source: "history",
    };
    const last = historyPoints[historyPoints.length - 1];
    if (last && last.x === summaryPoint.x) {
      historyPoints[historyPoints.length - 1] = summaryPoint;
    } else {
      historyPoints.push(summaryPoint);
    }
  }

  let currentSoc = resolveInitialSoc(summary, historyPoints);
  const futurePoints: ProjectionPoint[] = [];
  for (const era of futureEras) {
    addPoint(futurePoints, { x: era.startMs, y: currentSoc, source: "forecast" });
    const targetSoc = era.oracle?.end_soc_percent ?? era.oracle?.target_soc_percent ?? null;
    const endSoc = isFiniteNumber(targetSoc) ? targetSoc : currentSoc;
    addPoint(futurePoints, { x: era.endMs, y: endSoc, source: "forecast" });
    currentSoc = endSoc;
  }

  const combined = buildCombinedSeries(historyPoints, futurePoints);

  let currentMarker: ProjectionPoint | null = null;
  if (summarySoc !== null && summaryTimestamp !== null) {
    currentMarker = {
      x: summaryTimestamp,
      y: summarySoc,
      source: "history",
      isCurrentMarker: true,
    };
  } else if (historyPoints.length) {
    const anchor = historyPoints[historyPoints.length - 1];
    currentMarker = { ...anchor, isCurrentMarker: true };
  } else if (summary && isFiniteNumber(summary.current_soc_percent)) {
    const timestamp = parseTimestamp(summary.timestamp) ?? Date.now();
    currentMarker = {
      x: timestamp,
      y: summary.current_soc_percent,
      source: "history",
      isCurrentMarker: true,
    };
  }

  return { series: combined, currentMarker };
};

const buildGridSeries = (
  history: HistoryPoint[],
  futureEras: DerivedEra[],
): ProjectionPoint[] => {
  const historyPoints = history
    .map((entry) => toHistoryPoint(entry.timestamp, entry.grid_power_w ?? entry.grid_energy_w))
    .filter((point): point is ProjectionPoint => point !== null);

  const futurePoints: ProjectionPoint[] = [];
  for (const era of futureEras) {
    const power = era.oracle?.grid_power_w ?? era.oracle?.grid_energy_w ?? null;
    if (!isFiniteNumber(power)) {
      continue;
    }
    const midpoint = era.startMs + (era.endMs - era.startMs) / 2;
    futurePoints.push({ x: midpoint, y: power, source: "forecast" });
  }

  return [...historyPoints, ...futurePoints];
};

const buildSolarSeries = (
  history: HistoryPoint[],
  futureEras: DerivedEra[],
): ProjectionPoint[] => {
  const historyPoints = history
    .map((entry) => {
      const value = isFiniteNumber(entry.solar_power_w)
        ? entry.solar_power_w
        : isFiniteNumber(entry.solar_energy_wh)
          ? entry.solar_energy_wh
          : null;
      return toHistoryPoint(entry.timestamp, value);
    })
    .filter((point): point is ProjectionPoint => point !== null);

  const futurePoints: ProjectionPoint[] = [];
  for (const era of futureEras) {
    if (!isFiniteNumber(era.solarAverageW)) {
      continue;
    }
    const midpoint = era.startMs + (era.endMs - era.startMs) / 2;
    futurePoints.push({ x: midpoint, y: era.solarAverageW, source: "forecast" });
  }

  return [...historyPoints, ...futurePoints];
};

const buildPriceSeries = (
  history: HistoryPoint[],
  futureEras: DerivedEra[],
): ProjectionPoint[] => {
  const historyPoints = history
    .map((entry) => {
      const cents =
        entry.price_ct_per_kwh ??
        (typeof entry.price_eur_per_kwh === "number" ? entry.price_eur_per_kwh * 100 : null);
      return toHistoryPoint(entry.timestamp, cents);
    })
    .filter((point): point is ProjectionPoint => point !== null);
  const sortedHistory = sortChronologically(historyPoints);
  const firstFutureStart = futureEras[0]?.startMs;
  for (let i = 0; i < sortedHistory.length; i += 1) {
    const current = sortedHistory[i];
    const next = sortedHistory[i + 1];
    const fallbackStart = typeof firstFutureStart === "number" ? firstFutureStart : current.x + DEFAULT_SLOT_DURATION_MS;
    const rawEnd = next?.x ?? fallbackStart;
    current.xEnd = rawEnd > current.x ? rawEnd : current.x + DEFAULT_SLOT_DURATION_MS;
  }

  const futurePoints: ProjectionPoint[] = [];
  for (const era of futureEras) {
    if (!isFiniteNumber(era.priceCtPerKwh)) {
      continue;
    }
    futurePoints.push({
      x: era.startMs,
      xEnd: era.endMs,
      y: era.priceCtPerKwh,
      source: "forecast",
    });
  }

  return [...sortedHistory, ...futurePoints];
};

const resolvePointColor = (
  context: ScriptableContext<"line">,
  accent: string,
  useAccentForHistory = false,
): string => {
  const raw = context.raw as ProjectionPoint | undefined;
  if (!raw || Number.isNaN(raw.y)) {
    return "rgba(0,0,0,0)";
  }
  if (raw.source === "history" && !useAccentForHistory) {
    return HISTORY_POINT;
  }
  return accent;
};

const resolvePointRadius = (context: ScriptableContext<"line">): number => {
  const raw = context.raw as ProjectionPoint | undefined;
  if (!raw || Number.isNaN(raw.y)) {
    return 0;
  }
  return 3;
};

const resolveHoverRadius = (context: ScriptableContext<"line">): number => {
  const raw = context.raw as ProjectionPoint | undefined;
  if (!raw || Number.isNaN(raw.y)) {
    return 0;
  }
  return 6;
};

type LineSegmentContext = ScriptableLineSegmentContext;

const getSegmentSource = (
  context: LineSegmentContext,
): SeriesSource | undefined => {
  const datasetData = (context as { dataset?: { data?: unknown } }).dataset?.data;
  if (!Array.isArray(datasetData)) {
    return undefined;
  }
  const rawDataset = datasetData as unknown[];

  const maybeIndex = (context as {
    p1DataIndex?: unknown;
    p0DataIndex?: unknown;
  }).p1DataIndex;
  const maybeFallback = (context as { p0DataIndex?: unknown }).p0DataIndex;

  const index =
    typeof maybeIndex === "number"
      ? maybeIndex
      : typeof maybeFallback === "number"
        ? maybeFallback
        : undefined;

  if (index === undefined) {
    return undefined;
  }

  const candidate = rawDataset[index];
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const source = (candidate as { source?: unknown }).source;
  return source === "history" || source === "forecast" || source === "gap"
    ? source
    : undefined;
};

const resolveSegmentBorder = (
  context: LineSegmentContext,
  accent: string,
  historyAccent: string = HISTORY_BORDER,
) => {
  const source = getSegmentSource(context);
  return source === "history" ? historyAccent : accent;
};

const resolveSegmentBackground = (
  context: LineSegmentContext,
  accentFill: string,
  historyFill: string = HISTORY_FILL,
) => {
  const source = getSegmentSource(context);
  return source === "history" ? historyFill : accentFill;
};

const isProjectionPoint = (value: unknown): value is ProjectionPoint =>
  Boolean(
    value &&
      typeof value === "object" &&
      "x" in value &&
      "source" in value,
  );

const resolveBarColors = (
  point: unknown,
  forecastColor: string,
  historyColor: string,
) => {
  if (!isProjectionPoint(point) || typeof point.y !== "number" || Number.isNaN(point.y)) {
    return "rgba(0,0,0,0)";
  }
  return point.source === "history" ? historyColor : forecastColor;
};

const priceBarPlugin: Plugin = {
  id: "price-bar-plugin",
  beforeDatasetsDraw(chart) {
    const ctx = chart.ctx;
    const xScale = chart.scales.x;
    const yScale = chart.scales.price;
    if (!xScale || !yScale) {
      return;
    }

    chart.data.datasets.forEach((dataset, datasetIndex) => {
      if (dataset.label !== TARIFF_LABEL) {
        return;
      }

      const meta = chart.getDatasetMeta(datasetIndex);
      if (meta.hidden) {
        return;
      }

      const points = dataset.data as ProjectionPoint[];
      for (const point of points) {
        const value = point.y;
        if (typeof value !== "number" || Number.isNaN(value)) {
          continue;
        }
        const startValue = point.x;
        if (typeof startValue !== "number" || Number.isNaN(startValue)) {
          continue;
        }
        const endValue = typeof point.xEnd === "number" && Number.isFinite(point.xEnd)
          ? point.xEnd
          : startValue + DEFAULT_SLOT_DURATION_MS;
        const left = xScale.getPixelForValue(startValue);
        const right = xScale.getPixelForValue(endValue);
        const top = yScale.getPixelForValue(value);
        const base = yScale.getPixelForValue(0);

        const barLeft = Math.min(left, right);
        const barWidth = Math.max(1, Math.abs(right - left));
        const barTop = Math.min(top, base);
        const barHeight = Math.max(1, Math.abs(base - top));

        ctx.save();
        ctx.fillStyle = resolveBarColors(point, PRICE_FILL, PRICE_HISTORY_BAR_BG);
        ctx.strokeStyle = resolveBarColors(point, PRICE_BORDER, PRICE_HISTORY_BAR_BORDER);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(barLeft, barTop, barWidth, barHeight);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
    });
  },
};

Chart.register(priceBarPlugin);

const buildDatasets = (
  history: HistoryPoint[],
  forecast: ForecastEra[],
  oracleEntries: OracleEntry[],
  summary: SnapshotSummary | null,
): {
  datasets: ChartDataset<"line", ProjectionPoint[]>[];
  bounds: {
    power: AxisBounds;
    price: AxisBounds;
  };
  timeRange: { min: number | null; max: number | null };
} => {
  const futureEras = buildFutureEras(forecast, oracleEntries);
  const { series: socSeries, currentMarker } = buildSocSeries(history, futureEras, summary);
  const gridSeries = buildGridSeries(history, futureEras);
  const solarSeries = buildSolarSeries(history, futureEras);
  const priceSeries = buildPriceSeries(history, futureEras);
  const powerSeries = [...gridSeries, ...solarSeries];

  const datasets: ChartDataset<"line", ProjectionPoint[]>[] = [
    {
      type: "line",
      label: "State of Charge",
      data: socSeries,
      yAxisID: "soc",
      fill: "origin",
      tension: 0.3,
      spanGaps: false,
      borderWidth: 2,
      pointBorderWidth: 1,
      pointRadius: resolvePointRadius,
      pointHoverRadius: resolveHoverRadius,
      pointBackgroundColor: (ctx) => resolvePointColor(ctx, SOC_BORDER, true),
      pointBorderColor: (ctx) => resolvePointColor(ctx, SOC_BORDER, true),
      segment: {
        borderColor: (ctx) => resolveSegmentBorder(ctx, SOC_BORDER, SOC_BORDER),
        backgroundColor: (ctx) => resolveSegmentBackground(ctx, SOC_FILL, SOC_FILL),
      },
    },
    {
      type: "line",
      label: "Grid Power",
      data: gridSeries,
      yAxisID: "power",
      fill: "origin",
      tension: 0.3,
      spanGaps: false,
      borderWidth: 2,
      pointBorderWidth: 1,
      pointRadius: 0,
      pointHoverRadius: 0,
      pointBackgroundColor: (ctx) => resolvePointColor(ctx, GRID_BORDER),
      pointBorderColor: (ctx) => resolvePointColor(ctx, GRID_BORDER),
      segment: {
        borderColor: (ctx) => resolveSegmentBorder(ctx, GRID_BORDER),
        backgroundColor: (ctx) => resolveSegmentBackground(ctx, GRID_FILL),
      },
    },
    {
      type: "line",
      label: "Solar Generation",
      data: solarSeries,
      yAxisID: "power",
      fill: "origin",
      tension: 0.3,
      spanGaps: false,
      borderWidth: 2,
      pointBorderWidth: 1,
      pointRadius: 0,
      pointHoverRadius: 0,
      pointBackgroundColor: (ctx) => resolvePointColor(ctx, SOLAR_BORDER),
      pointBorderColor: (ctx) => resolvePointColor(ctx, SOLAR_BORDER),
      segment: {
        borderColor: (ctx) => resolveSegmentBorder(ctx, SOLAR_BORDER),
        backgroundColor: (ctx) => resolveSegmentBackground(ctx, SOLAR_FILL),
      },
    },
    {
      type: "line",
      label: GRID_MARKERS_LABEL,
      data: gridSeries.map((point) => ({ ...point })),
      yAxisID: "power",
      showLine: false,
      pointRadius: ({ raw }) => (isProjectionPoint(raw) && raw.source === "forecast" ? 5 : 3),
      pointHoverRadius: ({ raw }) => (isProjectionPoint(raw) && raw.source === "forecast" ? 7 : 5),
      pointBackgroundColor: ({ raw }) => resolveBarColors(raw, GRID_BORDER, HISTORY_POINT),
      pointBorderColor: ({ raw }) => resolveBarColors(raw, GRID_BORDER, HISTORY_BORDER),
    },
    {
      type: "line",
      label: TARIFF_LABEL,
      data: priceSeries,
      yAxisID: "price",
      fill: false,
      tension: 0.25,
      spanGaps: false,
      showLine: false,
      borderWidth: 2,
      pointBorderWidth: 1,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHitRadius: 6,
      segment: {
        borderColor: (ctx) => resolveSegmentBorder(ctx, PRICE_BORDER),
        backgroundColor: (ctx) => resolveSegmentBackground(ctx, PRICE_FILL),
      },
      borderColor: PRICE_BORDER,
      pointHoverBackgroundColor: ({ raw }) =>
        resolveBarColors(raw, PRICE_BORDER, PRICE_HISTORY_BAR_BORDER),
      pointHoverBorderColor: ({ raw }) =>
        resolveBarColors(raw, PRICE_BORDER, PRICE_HISTORY_BAR_BORDER),
    },
  ];

  if (currentMarker) {
    datasets.push({
      type: "line",
      label: "Current SOC",
      data: [{ ...currentMarker }],
      yAxisID: "soc",
      showLine: false,
      pointRadius: 9,
      pointHoverRadius: 11,
      pointBorderWidth: 2,
      pointBackgroundColor: SOC_BORDER,
      pointBorderColor: "#ffffff",
    });
  }

  const powerBounds = includeZeroInBounds(computeBounds(powerSeries, DEFAULT_POWER_BOUNDS));
  const priceBounds = includeZeroInBounds(computeBounds(priceSeries, DEFAULT_PRICE_BOUNDS));
  const timeRange = findTimeRange(socSeries, gridSeries, solarSeries, priceSeries);

  return {
    datasets,
    bounds: {
      power: powerBounds,
      price: priceBounds,
    },
    timeRange,
  };
};

const buildOptions = (config: {
  bounds: {
    power: AxisBounds;
    price: AxisBounds;
  };
  timeRange: { min: number | null; max: number | null };
}): ChartOptions<"line"> => ({
  responsive: true,
  maintainAspectRatio: false,
  interaction: {
    mode: "nearest",
    intersect: false,
  },
  plugins: {
    legend: {
      position: "top",
      labels: {
        color: LEGEND_COLOR,
        boxWidth: 16,
        usePointStyle: true,
        filter: (legendItem) => legendItem.text !== GRID_MARKERS_LABEL,
      },
    },
    tooltip: {
      callbacks: {
        title(items) {
          const value = items[0]?.parsed?.x;
          if (typeof value !== "number" || !Number.isFinite(value)) {
            return "";
          }
          return dateTimeFormatter.format(new Date(value));
        },
        label(item) {
          const { dataset, parsed } = item;
          const value =
            typeof parsed.y === "number" && Number.isFinite(parsed.y)
              ? parsed.y
              : null;
          if (value === null) {
            return "";
          }
          const baseLabel = dataset.label ? `${dataset.label}: ` : "";
          if (dataset.yAxisID === "soc") {
            return `${baseLabel}${percentFormatter.format(value)}%`;
          }
          if (dataset.yAxisID === "power") {
            return `${baseLabel}${numberFormatter.format(value)} W`;
          }
          if (dataset.yAxisID === "price") {
            return `${baseLabel}${numberFormatter.format(value)} ct/kWh`;
          }
          return `${baseLabel}${numberFormatter.format(value)}`;
        },
      },
    },
  },
  scales: {
    x: {
      type: "time",
      min: config.timeRange.min ?? undefined,
      max: config.timeRange.max ?? undefined,
      time: {
        unit: "hour",
        displayFormats: {
          hour: "HH:mm",
        },
      },
      ticks: {
        color: TICK_COLOR,
        maxRotation: 0,
        autoSkip: true,
        callback: (value) => {
          const numeric =
            typeof value === "number" ? value : Number(value);
          if (!Number.isFinite(numeric)) {
            return "";
          }
          const date = new Date(numeric);
          return timeFormatter.format(date);
        },
      },
      grid: {
        color: GRID_COLOR,
      },
    },
    soc: {
      type: "linear",
      position: "left",
      min: DEFAULT_SOC_BOUNDS.min,
      max: DEFAULT_SOC_BOUNDS.max,
      display: false,
      ticks: {
        color: TICK_COLOR,
        callback: (value) => {
          const numeric =
            typeof value === "number" ? value : Number(value);
          if (!Number.isFinite(numeric)) {
            return "";
          }
          return `${percentFormatter.format(numeric)}%`;
        },
      },
      grid: {
        display: false,
      },
    },
    power: {
      type: "linear",
      position: "left",
      min: config.bounds.power.min,
      max: config.bounds.power.max,
      ticks: {
        color: TICK_COLOR,
        callback: (value) => {
          const numeric =
            typeof value === "number" ? value : Number(value);
          if (!Number.isFinite(numeric)) {
            return "";
          }
          return `${numberFormatter.format(numeric)} W`;
        },
      },
      grid: {
        color: GRID_COLOR,
      },
      title: {
        display: true,
        text: "Watts",
        color: TICK_COLOR,
        font: {
          size: 12,
        },
      },
    },
    price: {
      type: "linear",
      position: "right",
      min: config.bounds.price.min,
      max: config.bounds.price.max,
      ticks: {
        color: TICK_COLOR,
        callback: (value) => {
          const numeric =
            typeof value === "number" ? value : Number(value);
          if (!Number.isFinite(numeric)) {
            return "";
          }
          return `${numberFormatter.format(numeric)} ct/kWh`;
        },
      },
      grid: {
        drawOnChartArea: false,
        color: GRID_COLOR,
      },
      title: {
        display: true,
        text: "ct/kWh",
        color: TICK_COLOR,
        font: {
          size: 12,
        },
      },
    },
  },
});

export const useProjectionChart = (
  history: HistoryPoint[],
  forecast: ForecastEra[],
  oracleEntries: OracleEntry[],
  summary: SnapshotSummary | null,
) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartInstance = useRef<Chart<"line", ProjectionPoint[]> | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }

    const { datasets, bounds, timeRange } = buildDatasets(history, forecast, oracleEntries, summary);
    const options = buildOptions({ bounds, timeRange });

    if (chartInstance.current) {
      chartInstance.current.destroy();
      chartInstance.current = null;
    }

    const chart = new Chart(context, {
      type: "line",
      data: { datasets },
      options,
    });

    chartInstance.current = chart;

    return () => {
      chart.destroy();
      chartInstance.current = null;
    };
  }, [
    history,
    forecast,
    oracleEntries,
    summary?.timestamp,
    summary?.current_soc_percent,
    summary?.next_step_soc_percent,
  ]);

  return canvasRef;
};
