import { useMemo } from "react";
import type { ChartDataset, ChartOptions } from "../useProjectionChart/chartSetup";
import { buildOptions } from "../useProjectionChart/buildOptions";
import { useChartInstance } from "../useProjectionChart/useChartInstance";
import type { BacktestSeriesPoint, BacktestSeriesResponse } from "../../types";
import type { AxisBounds, LegendGroup, ProjectionPoint } from "../useProjectionChart";
import { GRID_BORDER, GRID_FILL, HISTORY_BORDER, SOC_BORDER, SOC_FILL } from "../useProjectionChart/constants";

const toMs = (ts: string): number => new Date(ts).getTime();

interface BuildResult {
  datasets: ChartDataset<"line", ProjectionPoint[]>[];
  bounds: { power: AxisBounds; price: AxisBounds };
  timeRange: { min: number | null; max: number | null };
  legendGroups: LegendGroup[];
}

function buildDatasets(series: BacktestSeriesResponse): BuildResult {
  const points: BacktestSeriesPoint[] = Array.isArray(series?.points) ? series!.points : [];

  const socSmart: ProjectionPoint[] = [];
  const socDumb: ProjectionPoint[] = [];
  const gridSmart: ProjectionPoint[] = [];
  const gridDumb: ProjectionPoint[] = [];
  const savingsPoints: ProjectionPoint[] = [];

  let powerMin = Number.POSITIVE_INFINITY;
  let powerMax = Number.NEGATIVE_INFINITY;
  let eurMin = Number.POSITIVE_INFINITY; // in cents
  let eurMax = Number.NEGATIVE_INFINITY;
  let minTime: number | null = null;
  let maxTime: number | null = null;

  for (const p of points) {
    const start = toMs(p.start);
    const end = toMs(p.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    minTime = minTime == null ? start : Math.min(minTime, start);
    maxTime = maxTime == null ? end : Math.max(maxTime, end);

    const baseSavingsEur: number | null = typeof p.savings_cum_eur === "number" && Number.isFinite(p.savings_cum_eur)
      ? p.savings_cum_eur
      : (typeof p.savings_eur === "number" && Number.isFinite(p.savings_eur) ? p.savings_eur : null);
    const savingsCt = typeof baseSavingsEur === "number"
      ? baseSavingsEur * 100
      : null;
    if (typeof savingsCt === "number" && Number.isFinite(savingsCt)) {
      savingsPoints.push({x: start, y: savingsCt, source: "history"});
      savingsPoints.push({x: end, y: savingsCt, source: "history"});
      eurMin = Math.min(eurMin, savingsCt);
      eurMax = Math.max(eurMax, savingsCt);
    }

    if (typeof p.grid_power_smart_w === "number" && Number.isFinite(p.grid_power_smart_w)) {
      gridSmart.push({x: start, y: p.grid_power_smart_w, source: "history"});
      gridSmart.push({x: end, y: p.grid_power_smart_w, source: "history"});
      powerMin = Math.min(powerMin, p.grid_power_smart_w);
      powerMax = Math.max(powerMax, p.grid_power_smart_w);
    }

    if (typeof p.grid_power_dumb_w === "number" && Number.isFinite(p.grid_power_dumb_w)) {
      gridDumb.push({x: start, y: p.grid_power_dumb_w, source: "history"});
      gridDumb.push({x: end, y: p.grid_power_dumb_w, source: "history"});
      powerMin = Math.min(powerMin, p.grid_power_dumb_w);
      powerMax = Math.max(powerMax, p.grid_power_dumb_w);
    }

    if (typeof p.soc_smart_percent === "number" && Number.isFinite(p.soc_smart_percent)) {
      socSmart.push({x: end, y: p.soc_smart_percent, source: "history"});
    }
    if (typeof p.soc_dumb_percent === "number" && Number.isFinite(p.soc_dumb_percent)) {
      socDumb.push({x: end, y: p.soc_dumb_percent, source: "history"});
    }
  }

  if (!Number.isFinite(powerMin)) powerMin = 0;
  if (!Number.isFinite(powerMax)) powerMax = 0;
  if (!Number.isFinite(eurMin)) eurMin = 0;
  if (!Number.isFinite(eurMax)) eurMax = 0;

  // Padding for nicer visuals
  const pad = Math.max(100, Math.round((powerMax - powerMin) * 0.05));
  powerMin = Math.floor((powerMin - pad) / 100) * 100;
  powerMax = Math.ceil((powerMax + pad) / 100) * 100;
  const pricePad = Math.max(1, Math.round((eurMax - eurMin) * 0.05));
  eurMin = Math.floor(eurMin - pricePad);
  eurMax = Math.ceil(eurMax + pricePad);

  const datasets: ChartDataset<"line", ProjectionPoint[]>[] = [
    {
      type: "line",
      label: "Savings (ct)",
      data: savingsPoints,
      yAxisID: "price",
      borderColor: "#6C2BD9",
      backgroundColor: "rgba(108, 43, 217, 0.15)",
      pointRadius: 0,
      tension: 0,
      fill: true,
    },
    {
      type: "line",
      label: "Grid Power (smart)",
      data: gridSmart,
      yAxisID: "power",
      borderColor: GRID_BORDER,
      backgroundColor: GRID_FILL,
      pointRadius: 0,
      tension: 0,
      stepped: false,
    },
    {
      type: "line",
      label: "Grid Power (dumb)",
      data: gridDumb,
      yAxisID: "power",
      borderColor: HISTORY_BORDER,
      backgroundColor: "rgba(255, 99, 132, 0.15)",
      pointRadius: 0,
      tension: 0,
      borderDash: [6, 4],
      borderWidth: 3,
      fill: true,
    },
    {
      type: "line",
      label: "SOC (smart)",
      data: socSmart,
      yAxisID: "soc",
      borderColor: SOC_BORDER,
      backgroundColor: SOC_FILL,
      pointRadius: 0,
      tension: 0.2,
      fill: false,
    },
    {
      type: "line",
      label: "SOC (dumb)",
      data: socDumb,
      yAxisID: "soc",
      borderColor: HISTORY_BORDER,
      backgroundColor: "rgba(255, 99, 132, 0.08)",
      pointRadius: 2.5,
      tension: 0.2,
      borderDash: [6, 4],
      borderWidth: 3,
      fill: true,
    },
  ];

  const legendGroups: LegendGroup[] = [
    {label: "Savings", color: "#6C2BD9", datasetIndices: [0]},
    {label: "Grid Power", color: GRID_BORDER, datasetIndices: [1, 2]},
    {label: "State of Charge", color: SOC_BORDER, datasetIndices: [3, 4]},
  ];

  return {
    datasets,
    bounds: {
      power: {min: powerMin, max: powerMax, dataMin: null, dataMax: null},
      price: {min: eurMin, max: eurMax, dataMin: null, dataMax: null}
    },
    timeRange: {min: minTime, max: maxTime},
    legendGroups,
  };
}

export const useBacktestChart = (
  series: BacktestSeriesResponse | null,
  options?: {
    isMobile?: boolean;
    showPowerAxisLabels?: boolean;
    showPriceAxisLabels?: boolean;
    focus?: "smart" | "dumb"
  },
) => {
  const {datasets, bounds, timeRange, legendGroups} = useMemo(() => {
    if (!series) {
      return {
        datasets: [] as ChartDataset<"line", ProjectionPoint[]>[],
        bounds: {
          power: {min: 0, max: 0, dataMin: null, dataMax: null},
          price: {min: 0, max: 0, dataMin: null, dataMax: null}
        },
        timeRange: {min: null, max: null},
        legendGroups: [] as LegendGroup[],
      };
    }
    return buildDatasets(series);
  }, [series]);

  // Apply focus styling (smart vs dumb). We adjust colors post-build for clarity.
  const styledDatasets = useMemo(() => {
    const focus = options?.focus ?? "dumb";
    return datasets.map((d, i) => {
      // indices: 0 savings, 1 grid smart, 2 grid dumb, 3 soc smart, 4 soc dumb
      if (i === 0) return d; // keep savings styling
      const isSmart = i === 1 || i === 3;
      const isDumb = i === 2 || i === 4;
      if (focus === "smart" && isDumb) {
        return {
          ...d,
          borderColor: "#94a3b8",
          backgroundColor: "rgba(148, 163, 184, 0.08)",
          borderWidth: 2,
          fill: d.yAxisID === "soc" ? false : true,
        };
      }
      if (focus === "dumb" && isSmart) {
        return {
          ...d,
          borderColor: "#94a3b8",
          backgroundColor: "rgba(148, 163, 184, 0.08)",
          borderWidth: 2,
          fill: d.yAxisID === "soc" ? false : true,
        };
      }
      return d;
    });
  }, [datasets, options?.focus]);

  const chartOptions: ChartOptions<"line"> = useMemo(() => buildOptions({
    bounds,
    timeRange,
    legendGroups,
    responsive: options,
    valueAxisUnit: "ct"
  }), [bounds, timeRange, legendGroups, options?.isMobile, options?.showPowerAxisLabels, options?.showPriceAxisLabels]);

  return useChartInstance(styledDatasets, chartOptions);
};

export type { ProjectionPoint } from "../useProjectionChart";
