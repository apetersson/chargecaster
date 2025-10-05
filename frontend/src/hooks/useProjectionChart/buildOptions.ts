import { dateTimeFormatter, numberFormatter, percentFormatter, timeFormatter } from "../../utils/format";

import {
  GRID_COLOR,
  LEGEND_COLOR,
  GRID_MARKERS_LABEL,
  TICK_COLOR,
} from "./constants";
import { Chart, type ChartOptions, type LegendItem } from "./chartSetup";
import type { LegendGroup, AxisBounds, TimeRange } from "./types";

interface BuildOptionsConfig {
  bounds: {
    power: AxisBounds;
    price: AxisBounds;
  };
  timeRange: TimeRange;
  legendGroups: LegendGroup[];
  responsive?: { isMobile?: boolean; showPowerAxisLabels?: boolean; showPriceAxisLabels?: boolean };
}

export const buildOptions = ({bounds, timeRange, legendGroups, responsive}: BuildOptionsConfig): ChartOptions<"line"> => {
  const isMobile = Boolean(responsive?.isMobile);
  const showPowerAxisLabels = responsive?.showPowerAxisLabels ?? !isMobile;
  const showPriceAxisLabels = responsive?.showPriceAxisLabels ?? !isMobile;
  const groupedLegendEntries = legendGroups.filter((group) => group.datasetIndices.length > 0);
  const legendDefaults = Chart.defaults.plugins.legend;
  const legendLabelDefaults = legendDefaults.labels;
  const generateLegendLabels = legendLabelDefaults.generateLabels.bind(legendLabelDefaults);
  const legendClickDefault = (
    event: Parameters<NonNullable<typeof legendDefaults.onClick>>[0],
    legendItem: Parameters<NonNullable<typeof legendDefaults.onClick>>[1],
    legend: Parameters<NonNullable<typeof legendDefaults.onClick>>[2],
  ) => {
    legendDefaults.onClick?.call(legend, event, legendItem, legend);
  };
  const generateDefaultLabels = (chart: Chart): LegendItem[] => generateLegendLabels(chart);

  const options: ChartOptions<"line"> = {
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
          font: {
            weight: 500,
          },
          boxWidth: 16,
          usePointStyle: true,
          generateLabels: (chart) => {
            if (!groupedLegendEntries.length) {
              return generateDefaultLabels(chart).filter((item) => item.text !== GRID_MARKERS_LABEL);
            }
            const template = generateDefaultLabels(chart)[0];
            return groupedLegendEntries.map((group) => {
              const datasetIndex = group.datasetIndices[0];
              const hidden = group.datasetIndices.every((index) => chart.getDatasetMeta(index).hidden === true);
              return {
                text: group.label,
                fillStyle: group.color,
                strokeStyle: group.color,
                lineCap: template?.lineCap ?? "round",
                lineDash: template?.lineDash ?? [],
                lineDashOffset: template?.lineDashOffset ?? 0,
                lineJoin: template?.lineJoin ?? "round",
                lineWidth: template?.lineWidth ?? 2,
                color: LEGEND_COLOR,
                fontColor: LEGEND_COLOR,
                hidden,
                datasetIndex,
                datasetIndices: group.datasetIndices,
              } as LegendItem & { datasetIndices: number[] };
            });
          },
        },
        onClick: (event, legendItem, legend) => {
          const chart = legend.chart;
          const datasetIndices = (legendItem as LegendItem & { datasetIndices?: number[] }).datasetIndices;
          if (!datasetIndices || !datasetIndices.length || !groupedLegendEntries.length) {
            legendClickDefault(event, legendItem, legend);
            return;
          }
          datasetIndices.forEach((index) => {
            const visible = chart.isDatasetVisible(index);
            chart.setDatasetVisibility(index, !visible);
          });
          chart.update();
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
            const {dataset, parsed} = item;
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
        min: timeRange.min ?? undefined,
        max: timeRange.max ?? undefined,
        time: {
          unit: "hour",
          displayFormats: isMobile
            ? { hour: "HH 'h'" }
            : { hour: "HH:mm" },
        },
        ticks: {
          color: TICK_COLOR,
          maxRotation: 0,
          maxTicksLimit: isMobile ? 4 : undefined,
          autoSkip: true,
          callback: (value) => {
            const numeric =
              typeof value === "number" ? value : Number(value);
            if (!Number.isFinite(numeric)) {
              return "";
            }
            const date = new Date(numeric);
            if (isMobile) {
              const hours = String(date.getHours()).padStart(2, "0");
              return `${hours}h`;
            }
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
        min: 0,
        max: 100,
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
        min: bounds.power.min,
        max: bounds.power.max,
        ticks: {
          color: TICK_COLOR,
          display: showPowerAxisLabels,
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
          display: showPowerAxisLabels,
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
        min: bounds.price.min,
        max: bounds.price.max,
        ticks: {
          color: TICK_COLOR,
          display: showPriceAxisLabels,
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
          display: showPriceAxisLabels,
          text: "ct/kWh",
          color: TICK_COLOR,
          font: {
            size: 12,
          },
        },
      },
    },
  };

  return options;
};
