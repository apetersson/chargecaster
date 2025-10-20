import type { ForecastEra, HistoryPoint, OracleEntry, SnapshotSummary } from "../../types";
import type { ChartDataset } from "./chartSetup";

import { GRID_BORDER, GRID_FILL, GRID_MARKERS_LABEL, HISTORY_BORDER, HISTORY_POINT, PRICE_BORDER, PRICE_FILL, SOC_BORDER, SOC_FILL, SOLAR_BORDER, SOLAR_FILL, GAP_THRESHOLD_MS, DEMAND_BORDER, DEMAND_FILL } from "./constants";
import {
  addPoint,
  attachHistoryIntervals,
  buildCombinedSeries,
  buildFutureEras,
  computeTimeRangeMs,
  derivePowerFromEnergy,
  ensureBounds,
  isFiniteNumber,
  parseTimestamp,
  pushGapPoint,
  resolvePriceValue,
  toHistoryPoint,
} from "./helpers";
import {
  resolveBarColors,
  resolveHoverRadius,
  resolvePointColor,
  resolvePointRadius,
  resolveSegmentBackground,
  resolveSegmentBorder,
} from "./styling";
import type {
  AxisBounds,
  DerivedEra,
  LegendGroup,
  ProjectionPoint,
  TimeRangeMs,
} from "./types";

const resolveInitialSoCPercent = (
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

const buildSoCSeries = (
  history: HistoryPoint[],
  futureEras: DerivedEra[],
  summary: SnapshotSummary | null,
): { series: ProjectionPoint[]; currentMarker: ProjectionPoint | null } => {
  const historyPoints = history
    .map((entry) => toHistoryPoint(entry.timestamp, entry.battery_soc_percent))
    .filter((point): point is ProjectionPoint => point !== null);

  const summarySoCPercent = summary && isFiniteNumber(summary.current_soc_percent)
    ? summary.current_soc_percent
    : null;
  const summaryTimestamp = summary?.timestamp ? parseTimestamp(summary.timestamp) : null;
  if (summarySoCPercent !== null && summaryTimestamp !== null) {
    const summaryPoint: ProjectionPoint = {
      x: summaryTimestamp,
      y: summarySoCPercent,
      source: "history",
    };
    const last = historyPoints[historyPoints.length - 1];
    if (last && last.x === summaryPoint.x) {
      historyPoints[historyPoints.length - 1] = summaryPoint;
    } else {
      historyPoints.push(summaryPoint);
    }
  }

  let currentSoCPercent = resolveInitialSoCPercent(summary, historyPoints);
  const futurePoints: ProjectionPoint[] = [];
  for (const era of futureEras) {
    addPoint(futurePoints, {x: era.startMs, y: currentSoCPercent, source: "forecast"});
    const targetSoCPercent = era.oracle?.end_soc_percent ?? era.oracle?.target_soc_percent ?? null;
    const endSoCPercent = isFiniteNumber(targetSoCPercent) ? targetSoCPercent : currentSoCPercent;
    addPoint(futurePoints, {x: era.endMs, y: endSoCPercent, source: "forecast"});
    currentSoCPercent = endSoCPercent;
  }

  const combined = buildCombinedSeries(historyPoints, futurePoints);

  let currentMarker: ProjectionPoint | null = null;
  if (summarySoCPercent !== null && summaryTimestamp !== null) {
    currentMarker = {
      x: summaryTimestamp,
      y: summarySoCPercent,
      source: "history",
      isCurrentMarker: true,
    };
  } else if (historyPoints.length) {
    const anchor = historyPoints[historyPoints.length - 1];
    currentMarker = {...anchor, isCurrentMarker: true};
  } else if (summary && isFiniteNumber(summary.current_soc_percent)) {
    const timestamp = parseTimestamp(summary.timestamp) ?? Date.now();
    currentMarker = {
      x: timestamp,
      y: summary.current_soc_percent,
      source: "history",
      isCurrentMarker: true,
    };
  }

  return {series: combined, currentMarker};
};

const buildGridSeries = (
  history: HistoryPoint[],
  futureEras: DerivedEra[],
): ProjectionPoint[] => {
  const historyPoints = history
    .map((entry) => {
      const power = isFiniteNumber(entry.grid_power_w) ? entry.grid_power_w : null;
      return toHistoryPoint(entry.timestamp, power);
    })
    .filter((point): point is ProjectionPoint => point !== null);

  const futurePoints: ProjectionPoint[] = [];
  for (const era of futureEras) {
    const power = derivePowerFromEnergy(
      era.oracle?.grid_energy_wh ?? null,
      era.slot.duration.hours,
    );
    if (!isFiniteNumber(power)) {
      continue;
    }
    const midpoint = era.startMs + (era.endMs - era.startMs) / 2;
    futurePoints.push({x: midpoint, y: power, source: "forecast"});
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
  let hadActiveSegment = false;
  let lastDataEraEnd: number | null = null;

  for (const era of futureEras) {
    const hasSolar = isFiniteNumber(era.solarAverageW);

    if (!hasSolar) {
      if (hadActiveSegment) {
        pushGapPoint(futurePoints, era.startMs);
        hadActiveSegment = false;
      }
      continue;
    }

    if (lastDataEraEnd !== null) {
      const gapDuration = era.startMs - lastDataEraEnd;
      if (gapDuration > GAP_THRESHOLD_MS) {
        pushGapPoint(futurePoints, era.startMs);
        hadActiveSegment = false;
      }
    }

    if (!hadActiveSegment && futurePoints.length) {
      pushGapPoint(futurePoints, era.startMs);
    }

    const midpoint = era.startMs + (era.endMs - era.startMs) / 2;
    const solarAverage = era.solarAverageW as number;
    futurePoints.push({x: midpoint, y: solarAverage, source: "forecast"});
    hadActiveSegment = true;
    lastDataEraEnd = era.endMs;
  }

  return buildCombinedSeries(historyPoints, futurePoints);
};

const buildDemandSeries = (
  history: HistoryPoint[],
  futureEras: DerivedEra[],
  summary: SnapshotSummary | null,
): ProjectionPoint[] => {
  const historyPoints = history
    .map((entry) => toHistoryPoint(entry.timestamp, entry.home_power_w ?? null))
    .filter((p): p is ProjectionPoint => p !== null);

  const r = typeof summary?.solar_direct_use_ratio === "number" && Number.isFinite(summary.solar_direct_use_ratio)
    ? summary.solar_direct_use_ratio
    : 0.6;
  const bp = typeof summary?.house_load_w === "number" && Number.isFinite(summary.house_load_w)
    ? summary.house_load_w
    : 0;

  const futurePoints: ProjectionPoint[] = [];
  for (const era of futureEras) {
    const midpoint = era.startMs + (era.endMs - era.startMs) / 2;
    const solarAvg = isFiniteNumber(era.solarAverageW) ? era.solarAverageW : 0;
    const demand = bp + r * solarAvg;
    futurePoints.push({x: midpoint, y: demand, source: "forecast"});
  }
  return buildCombinedSeries(historyPoints, futurePoints);
};

const buildPriceSeries = (
  history: HistoryPoint[],
  futureEras: DerivedEra[],
): ProjectionPoint[] => {
  const historyPoints = history
    .map((entry) => toHistoryPoint(entry.timestamp, resolvePriceValue(entry)))
    .filter((point): point is ProjectionPoint => point !== null);
  const sortedHistory = historyPoints.sort((a, b) => a.x - b.x);
  const firstFutureStart = futureEras[0]?.startMs;
  attachHistoryIntervals(sortedHistory, firstFutureStart);

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
      strategy: era.oracle?.strategy,
    });
  }

  return [...sortedHistory, ...futurePoints];
};

const buildLegendGroups = (
  datasets: ChartDataset<"line", ProjectionPoint[]>[],
): LegendGroup[] => {
  const labelToIndices = new Map<string, number[]>();
  datasets.forEach((dataset, index) => {
    const key = dataset.label ?? `dataset-${index}`;
    const existing = labelToIndices.get(key);
    if (existing) {
      existing.push(index);
    } else {
      labelToIndices.set(key, [index]);
    }
  });

  const legendConfig: { label: string; color: string; datasetLabels: string[] }[] = [
    {label: "State of Charge", color: SOC_BORDER, datasetLabels: ["State of Charge"]},
    {label: "Grid Power", color: GRID_BORDER, datasetLabels: ["Grid Power", GRID_MARKERS_LABEL]},
    {label: "Solar Generation", color: SOLAR_BORDER, datasetLabels: ["Solar Generation"]},
    {label: "House Demand", color: DEMAND_BORDER, datasetLabels: ["House Demand"]},
    {label: "Tariff", color: PRICE_BORDER, datasetLabels: ["Tariff"]},
    {label: "Current SOC", color: SOC_BORDER, datasetLabels: ["Current SOC"]},
  ];

  return legendConfig
    .map((entry) => {
      const indices = entry.datasetLabels.flatMap((datasetLabel) => labelToIndices.get(datasetLabel) ?? []);
      if (!indices.length) {
        return null;
      }
      return {label: entry.label, color: entry.color, datasetIndices: indices};
    })
    .filter((item): item is LegendGroup => item !== null);
};

export const buildDatasets = (
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
  timeRangeMs: TimeRangeMs;
  legendGroups: LegendGroup[];
} => {
  const futureEras = buildFutureEras(forecast, oracleEntries);
  const {series: socSeries, currentMarker} = buildSoCSeries(history, futureEras, summary);
  const gridSeries = buildGridSeries(history, futureEras);
  const solarSeries = buildSolarSeries(history, futureEras);
  const demandSeries = buildDemandSeries(history, futureEras, summary);
  const priceSeries = buildPriceSeries(history, futureEras);
  const powerSeries = [...gridSeries, ...solarSeries, ...demandSeries];

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
      label: "House Demand",
      data: demandSeries,
      yAxisID: "power",
      fill: "origin",
      tension: 0.25,
      spanGaps: false,
      borderWidth: 2,
      pointBorderWidth: 1,
      pointRadius: 0,
      pointHoverRadius: 0,
      pointBackgroundColor: (ctx) => resolvePointColor(ctx, DEMAND_BORDER),
      pointBorderColor: (ctx) => resolvePointColor(ctx, DEMAND_BORDER),
      segment: {
        borderColor: (ctx) => resolveSegmentBorder(ctx, DEMAND_BORDER),
        backgroundColor: (ctx) => resolveSegmentBackground(ctx, DEMAND_FILL),
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
      data: gridSeries.map((point) => ({...point})),
      yAxisID: "power",
      showLine: false,
      pointRadius: ({raw}) => (isProjectionPoint(raw) && raw.source === "forecast" ? 5 : 3),
      pointHoverRadius: ({raw}) => (isProjectionPoint(raw) && raw.source === "forecast" ? 7 : 5),
      pointBackgroundColor: ({raw}) => resolveBarColors(raw, GRID_BORDER, HISTORY_POINT),
      pointBorderColor: ({raw}) => resolveBarColors(raw, GRID_BORDER, HISTORY_BORDER),
    },
    {
      type: "line",
      label: "Tariff",
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
      // hover styles are not used for price bars (rendered via plugin)
    },
  ];

  if (currentMarker) {
    datasets.push({
      type: "line",
      label: "Current SOC",
      data: [{...currentMarker}],
      yAxisID: "soc",
      showLine: false,
      pointRadius: 9,
      pointHoverRadius: 11,
      pointBorderWidth: 2,
      pointBackgroundColor: SOC_BORDER,
      pointBorderColor: "#ffffff",
    });
  }

  const bounds = ensureBounds(powerSeries, priceSeries);
  const timeRangeMs: TimeRangeMs = computeTimeRangeMs(socSeries, gridSeries, solarSeries, priceSeries);
  const legendGroups = buildLegendGroups(datasets);

  return {
    datasets,
    bounds,
    timeRangeMs,
    legendGroups,
  };
};

function isProjectionPoint(value: unknown): value is ProjectionPoint {
  if (typeof value !== "object" || value === null) return false;
  const v = value as { x?: unknown; source?: unknown };
  const validSource = v.source === "history" || v.source === "forecast" || v.source === "gap";
  return typeof v.x === "number" && Number.isFinite(v.x) && validSource;
}
