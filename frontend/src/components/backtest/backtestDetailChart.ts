import type { ChartDataset, ChartOptions } from "../../hooks/useProjectionChart/chartSetup";
import type { ProjectionPoint } from "../../hooks/useProjectionChart/types";
import type { DailyBacktestDetail } from "../../types";
import { formatNumber } from "../../utils/format";

type BacktestChartSeries = {
  hasIntervals: boolean;
  pricePoints: ProjectionPoint[];
  datasets: ChartDataset<"line", ProjectionPoint[]>[];
};

function toPoint(x: number, y: number): ProjectionPoint {
  return {
    x,
    y,
    source: "history",
  };
}

function smoothSeries(points: ProjectionPoint[], radius: number): ProjectionPoint[] {
  if (radius <= 0 || points.length <= 1) {
    return points;
  }

  return points.map((point, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(points.length - 1, index + radius);
    let total = 0;
    let count = 0;

    for (let cursor = start; cursor <= end; cursor += 1) {
      total += points[cursor]?.y ?? 0;
      count += 1;
    }

    return toPoint(Number(point.x), count > 0 ? total / count : point.y);
  });
}

export function findPricePoint(points: ProjectionPoint[], timestampMs: number): ProjectionPoint | null {
  for (const point of points) {
    const startMs = Number(point.x);
    const endMs = typeof point.xEnd === "number" ? point.xEnd : startMs;
    if (timestampMs >= startMs && timestampMs < endMs) {
      return point;
    }
  }
  return points[points.length - 1] ?? null;
}

export function buildBacktestChartSeries(entry: DailyBacktestDetail): BacktestChartSeries {
  const intervals = entry.result.intervals;
  const hasIntervals = intervals.length > 0;
  const firstInterval = hasIntervals ? intervals[0] : null;
  const lastInterval = hasIntervals ? intervals[intervals.length - 1] : null;

  const actualSocPoints: ProjectionPoint[] = [];
  const autoSocPoints: ProjectionPoint[] = [];
  const savingsPoints: ProjectionPoint[] = [];
  const pricePoints: ProjectionPoint[] = [];
  const solarChargePoints: ProjectionPoint[] = [];
  const actualGridChargePoints: ProjectionPoint[] = [];

  if (firstInterval) {
    savingsPoints.push(toPoint(new Date(firstInterval.timestamp).getTime(), 0));
  }

  for (const interval of intervals) {
    actualSocPoints.push(toPoint(new Date(interval.timestamp).getTime(), interval.actual_soc_percent));
    autoSocPoints.push(toPoint(new Date(interval.timestamp).getTime(), interval.simulated_soc_start_percent));
    savingsPoints.push(toPoint(new Date(interval.end_timestamp).getTime(), interval.cumulative_savings_eur));
    pricePoints.push({
      x: new Date(interval.timestamp).getTime(),
      xEnd: new Date(interval.end_timestamp).getTime(),
      y: interval.price_eur_per_kwh * 100,
      source: "history",
    });
    solarChargePoints.push(toPoint(new Date(interval.end_timestamp).getTime(), interval.simulated_charge_from_solar_w / 1000));
    actualGridChargePoints.push(toPoint(new Date(interval.end_timestamp).getTime(), interval.actual_charge_from_grid_w / 1000));
  }

  if (lastInterval) {
    actualSocPoints.push(toPoint(new Date(lastInterval.end_timestamp).getTime(), entry.result.actual_final_soc_percent));
    autoSocPoints.push(toPoint(new Date(lastInterval.end_timestamp).getTime(), entry.result.simulated_final_soc_percent));
  }

  return {
    hasIntervals,
    pricePoints,
    datasets: [
      {
        label: "Tariff",
        data: pricePoints,
        parsing: false,
        pointRadius: 0,
        pointHoverRadius: 0,
        borderWidth: 0,
        showLine: false,
        yAxisID: "price",
        order: -2,
      },
      {
        label: "Charge from Solar",
        data: solarChargePoints,
        parsing: false,
        borderColor: "rgba(251, 191, 36, 0.55)",
        backgroundColor: "rgba(251, 191, 36, 0.12)",
        pointRadius: 0,
        pointHoverRadius: 2,
        borderWidth: 1.5,
        tension: 0.14,
        fill: true,
        yAxisID: "charge",
        order: -1,
      },
      {
        label: "Estimated Charge from Grid",
        data: smoothSeries(actualGridChargePoints, 2),
        parsing: false,
        borderColor: "rgba(251, 113, 133, 0.5)",
        backgroundColor: "rgba(251, 113, 133, 0.08)",
        pointRadius: 0,
        pointHoverRadius: 2,
        borderWidth: 1.5,
        tension: 0.14,
        fill: true,
        yAxisID: "charge",
        order: -1,
      },
      {
        label: "Actual SOC",
        data: actualSocPoints,
        parsing: false,
        borderColor: "#38bdf8",
        backgroundColor: "rgba(56, 189, 248, 0.18)",
        pointRadius: 0,
        pointHoverRadius: 2,
        borderWidth: 2,
        tension: 0.18,
        yAxisID: "soc",
        order: 2,
      },
      {
        label: "Auto SOC",
        data: autoSocPoints,
        parsing: false,
        borderColor: "#f59e0b",
        backgroundColor: "rgba(245, 158, 11, 0.18)",
        pointRadius: 0,
        pointHoverRadius: 2,
        borderWidth: 2,
        tension: 0.18,
        yAxisID: "soc",
        order: 2,
      },
      {
        label: "Inferred Savings",
        data: savingsPoints,
        parsing: false,
        borderColor: "#22c55e",
        backgroundColor: "rgba(34, 197, 94, 0.14)",
        pointRadius: 0,
        pointHoverRadius: 2,
        borderWidth: 2,
        tension: 0.12,
        yAxisID: "savings",
        order: 3,
      },
    ],
  };
}

export function buildBacktestChartOptions(pricePoints: ProjectionPoint[]): ChartOptions<"line"> {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: "index",
      intersect: false,
    },
    plugins: {
      legend: {
        position: "top",
        labels: {
          color: "#e2e8f0",
          boxWidth: 12,
          boxHeight: 12,
          filter(item) {
            return item.text !== "Tariff";
          },
        },
      },
      tooltip: {
        filter(context) {
          return context.dataset.label !== "Tariff";
        },
        callbacks: {
          afterBody(items) {
            const hoveredTimestampMs = items[0]?.parsed.x;
            if (typeof hoveredTimestampMs !== "number" || !Number.isFinite(hoveredTimestampMs)) {
              return [];
            }
            const pricePoint = findPricePoint(pricePoints, hoveredTimestampMs);
            if (!pricePoint) {
              return [];
            }
            return [`Price: ${formatNumber(pricePoint.y, " ct/kWh")}`];
          },
          label(context) {
            const label = context.dataset.label ?? "";
            if (context.dataset.yAxisID === "savings") {
              return `${label}: ${formatNumber(context.parsed.y, " EUR")}`;
            }
            if (context.dataset.yAxisID === "charge") {
              return `${label}: ${formatNumber(context.parsed.y, " kW")}`;
            }
            return `${label}: ${formatNumber(context.parsed.y, "%")}`;
          },
        },
      },
    },
    scales: {
      x: {
        type: "time",
        time: {
          unit: "hour",
          displayFormats: { hour: "HH:mm" },
          tooltipFormat: "yyyy-MM-dd HH:mm",
        },
        ticks: {
          color: "rgba(226, 232, 240, 0.85)",
        },
        grid: {
          color: "rgba(148, 163, 184, 0.12)",
        },
      },
      price: {
        type: "linear",
        position: "right",
        display: false,
        min: 0,
        grid: {
          display: false,
          drawOnChartArea: false,
        },
        ticks: {
          display: false,
        },
      },
      charge: {
        type: "linear",
        position: "left",
        display: false,
        min: 0,
        grid: {
          display: false,
          drawOnChartArea: false,
        },
        ticks: {
          display: false,
        },
      },
      soc: {
        type: "linear",
        position: "left",
        min: 0,
        max: 100,
        ticks: {
          color: "rgba(226, 232, 240, 0.85)",
          callback(value) {
            return `${value}%`;
          },
        },
        title: {
          display: true,
          text: "SOC %",
          color: "rgba(226, 232, 240, 0.85)",
        },
        grid: {
          color: "rgba(148, 163, 184, 0.12)",
        },
      },
      savings: {
        type: "linear",
        position: "right",
        ticks: {
          color: "rgba(187, 247, 208, 0.95)",
          callback(value) {
            return `${Number(value).toFixed(1)} EUR`;
          },
        },
        title: {
          display: true,
          text: "Inferred Savings",
          color: "rgba(187, 247, 208, 0.95)",
        },
        grid: {
          drawOnChartArea: false,
          color: "rgba(34, 197, 94, 0.12)",
        },
      },
    },
  };
}
