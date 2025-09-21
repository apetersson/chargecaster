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
} from "chart.js";
import "chartjs-adapter-date-fns";

import type { HistoryPoint, TrajectoryPoint } from "../types";
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
const PRICE_BORDER = "#38bdf8";
const PRICE_FILL = "rgba(56, 189, 248, 0.15)";
const GRID_COLOR = "rgba(148, 163, 184, 0.25)";
const TICK_COLOR = "#64748b";
const LEGEND_COLOR = "#475569";
const PRICE_HISTORY_BAR_BG = "rgba(148, 163, 184, 0.3)";
const PRICE_HISTORY_BAR_BORDER = "rgba(100, 116, 139, 1)";
const DEFAULT_SLOT_DURATION_MS = 3_600_000;

const DEFAULT_SOC_BOUNDS = { min: 0, max: 100 };
const DEFAULT_GRID_BOUNDS = { min: 0, max: 1 };
const DEFAULT_PRICE_BOUNDS = { min: 0, max: 0.5 };

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

const filterFutureTrajectory = (trajectory: TrajectoryPoint[]): TrajectoryPoint[] => {
  const now = Date.now();
  return [...trajectory].filter((slot) => {
    const start = parseTimestamp(slot.start);
    const end = parseTimestamp(slot.end);
    if (!start || !end) {
      return false;
    }
    if (end <= now) {
      return false;
    }
    return start > now;
  }).sort((a, b) => {
    const startA = parseTimestamp(a.start) ?? 0;
    const startB = parseTimestamp(b.start) ?? 0;
    return startA - startB;
  });
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

const toForecastPoint = (
  timestamp: string,
  value: number | null | undefined,
  endTimestamp?: string,
): ProjectionPoint | null => {
  if (!isFiniteNumber(value)) {
    return null;
  }

  const time = parseTimestamp(timestamp);
  if (time === null) {
    return null;
  }

  const xEnd = parseTimestamp(endTimestamp ?? null);
  return { x: time, xEnd, y: value, source: "forecast" };
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

const buildSocSeries = (
  history: HistoryPoint[],
  futureTrajectory: TrajectoryPoint[],
): ProjectionPoint[] => {
  const historyPoints = history
    .map((entry) => toHistoryPoint(entry.timestamp, entry.battery_soc_percent))
    .filter((point): point is ProjectionPoint => point !== null);

  const futurePoints: ProjectionPoint[] = [];
  for (const slot of futureTrajectory) {
    addPoint(futurePoints, toForecastPoint(slot.start, slot.soc_start_percent));
    addPoint(futurePoints, toForecastPoint(slot.end, slot.soc_end_percent));
  }

  return buildCombinedSeries(historyPoints, futurePoints);
};

const buildGridSeries = (
  history: HistoryPoint[],
  futureTrajectory: TrajectoryPoint[],
): ProjectionPoint[] => {
  const historyPoints = history
    .map((entry) => toHistoryPoint(entry.timestamp, entry.grid_energy_kwh))
    .filter((point): point is ProjectionPoint => point !== null);

  const futurePoints: ProjectionPoint[] = futureTrajectory
    .map((slot) => {
      const start = parseTimestamp(slot.start);
      const end = parseTimestamp(slot.end);
      if (start === null || end === null || end <= start) {
        return null;
      }
      const midpoint = start + (end - start) / 2;
      return { x: midpoint, y: slot.grid_energy_kwh, source: "forecast" as SeriesSource } satisfies ProjectionPoint;
    })
    .filter((value): value is ProjectionPoint => value !== null);

  return [...historyPoints, ...futurePoints];
};

const buildPriceSeries = (
  history: HistoryPoint[],
  futureTrajectory: TrajectoryPoint[],
): ProjectionPoint[] => {
  const historyPoints = history
    .map((entry) => toHistoryPoint(entry.timestamp, entry.price_eur_per_kwh))
    .filter((point): point is ProjectionPoint => point !== null);
  const sortedHistory = sortChronologically(historyPoints);
  for (let i = 0; i < sortedHistory.length; i += 1) {
    const current = sortedHistory[i];
    const next = sortedHistory[i + 1];
    const fallbackStart = parseTimestamp(futureTrajectory[0]?.start) ?? current.x + DEFAULT_SLOT_DURATION_MS;
    const rawEnd = next?.x ?? fallbackStart;
    current.xEnd = rawEnd > current.x ? rawEnd : current.x + DEFAULT_SLOT_DURATION_MS;
  }

  const futurePoints: ProjectionPoint[] = [];
  for (const slot of futureTrajectory) {
    const start = parseTimestamp(slot.start);
    const end = parseTimestamp(slot.end);
    if (start === null || end === null) {
      continue;
    }
    futurePoints.push({
      x: start,
      xEnd: end,
      y: slot.price_eur_per_kwh,
      source: "forecast",
    });
  }

  return [...sortedHistory, ...futurePoints];
};

const resolvePointColor = (
  context: ScriptableContext<"line">,
  accent: string,
): string => {
  const raw = context.raw as ProjectionPoint | undefined;
  if (!raw || Number.isNaN(raw.y)) {
    return "rgba(0,0,0,0)";
  }
  return raw.source === "history" ? HISTORY_POINT : accent;
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

type LineSegmentContext = Parameters<Required<ChartDataset<"line">["segment"]>["borderColor"]>[0];

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
) => {
  const source = getSegmentSource(context);
  return source === "history" ? HISTORY_BORDER : accent;
};

const resolveSegmentBackground = (
  context: LineSegmentContext,
  accentFill: string,
) => {
  const source = getSegmentSource(context);
  return source === "history" ? HISTORY_FILL : accentFill;
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
      if (dataset.label !== "Tariff") {
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
  trajectory: TrajectoryPoint[],
): {
  datasets: Array<
    | ChartDataset<"line", ProjectionPoint[]>
    | ChartDataset<"scatter", ProjectionPoint[]>
  >;
  bounds: {
    soc: AxisBounds;
    grid: AxisBounds;
    price: AxisBounds;
  };
  timeRange: { min: number | null; max: number | null };
} => {
  const futureTrajectory = filterFutureTrajectory(trajectory);
  const socSeries = buildSocSeries(history, futureTrajectory);
  const gridSeries = buildGridSeries(history, futureTrajectory);
  const priceSeries = buildPriceSeries(history, futureTrajectory);

  const datasets: Array<
    | ChartDataset<"line", ProjectionPoint[]>
    | ChartDataset<"scatter", ProjectionPoint[]>
  > = [
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
      pointBackgroundColor: (ctx) => resolvePointColor(ctx, SOC_BORDER),
      pointBorderColor: (ctx) => resolvePointColor(ctx, SOC_BORDER),
      segment: {
        borderColor: (ctx) => resolveSegmentBorder(ctx, SOC_BORDER),
        backgroundColor: (ctx) => resolveSegmentBackground(ctx, SOC_FILL),
      },
    },
    {
      type: "line",
      label: "Energy from Grid",
      data: gridSeries,
      yAxisID: "grid",
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
      type: "scatter",
      label: "Grid Energy Markers",
      data: (() => {
        const historyDots = gridSeries
          .filter((point) => point.source === "history")
          .map((point) => ({ ...point }));
        const futureDots = futureTrajectory
          .map((slot) => {
            const start = parseTimestamp(slot.start);
            const end = parseTimestamp(slot.end);
            if (start === null || end === null || end <= start) {
              return null;
            }
            const midpoint = start + (end - start) / 2;
            return {
              x: midpoint,
              y: slot.grid_energy_kwh,
              source: "forecast" as SeriesSource,
            } satisfies ProjectionPoint;
          })
          .filter((value): value is ProjectionPoint => value !== null);
        return [...historyDots, ...futureDots];
      })(),
      yAxisID: "grid",
      showLine: false,
      pointRadius: ({ raw }) => (isProjectionPoint(raw) && raw.source === "forecast" ? 5 : 3),
      pointHoverRadius: ({ raw }) => (isProjectionPoint(raw) && raw.source === "forecast" ? 7 : 5),
      pointBackgroundColor: ({ raw }) =>
        resolveBarColors(raw, GRID_BORDER, HISTORY_POINT),
      pointBorderColor: ({ raw }) => resolveBarColors(raw, GRID_BORDER, HISTORY_BORDER),
    },
    {
      type: "line",
      label: "Tariff",
      data: priceSeries,
      yAxisID: "price",
      showLine: false,
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHitRadius: 6,
      pointHoverBackgroundColor: ({ raw }) =>
        resolveBarColors(raw, PRICE_BORDER, PRICE_HISTORY_BAR_BORDER),
      pointHoverBorderColor: ({ raw }) =>
        resolveBarColors(raw, PRICE_BORDER, PRICE_HISTORY_BAR_BORDER),
    },
  ];

  const socBounds = computeBounds(socSeries, DEFAULT_SOC_BOUNDS);
  const gridBoundsRaw = computeBounds(gridSeries, DEFAULT_GRID_BOUNDS);
  let gridMax = gridBoundsRaw.dataMax ?? DEFAULT_GRID_BOUNDS.max;
  if (!(typeof gridMax === "number" && Number.isFinite(gridMax) && gridMax > 0)) {
    gridMax = DEFAULT_GRID_BOUNDS.max;
  }
  const gridBounds: AxisBounds = {
    ...gridBoundsRaw,
    min: 0,
    max: gridMax,
    dataMin: gridBoundsRaw.dataMin === null ? 0 : Math.min(0, gridBoundsRaw.dataMin),
    dataMax: gridBoundsRaw.dataMax,
  };
  const priceBounds = computeBounds(priceSeries, DEFAULT_PRICE_BOUNDS);
  const timeRange = findTimeRange(socSeries, gridSeries, priceSeries);

  return {
    datasets,
    bounds: {
      soc: socBounds,
      grid: gridBounds,
      price: priceBounds,
    },
    timeRange,
  };
};

const buildOptions = (config: {
  bounds: {
    soc: AxisBounds;
    grid: AxisBounds;
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
          if (dataset.yAxisID === "grid") {
            return `${baseLabel}${numberFormatter.format(value)} kW`;
          }
          if (dataset.yAxisID === "price") {
            return `${baseLabel}${numberFormatter.format(value * 100)} ct/kWh`;
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
        color: GRID_COLOR,
      },
    },
    grid: {
      type: "linear",
      position: "right",
      min: config.bounds.grid.min,
      max: config.bounds.grid.max,
      ticks: {
        color: TICK_COLOR,
        callback: (value) => {
          const numeric =
            typeof value === "number" ? value : Number(value);
          if (!Number.isFinite(numeric)) {
            return "";
          }
          return `${numberFormatter.format(numeric)} kW`;
        },
      },
      grid: {
        drawOnChartArea: false,
        color: GRID_COLOR,
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
          return `${numberFormatter.format(numeric * 100)} ct/kWh`;
        },
      },
      grid: {
        drawOnChartArea: false,
        color: GRID_COLOR,
      },
    },
  },
});

export const useProjectionChart = (
  history: HistoryPoint[],
  trajectory: TrajectoryPoint[],
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

    const { datasets, bounds, timeRange } = buildDatasets(history, trajectory);
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
  }, [history, trajectory]);

  return canvasRef;
};
