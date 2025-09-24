import {
  BarController,
  BarElement,
  Chart,
  Filler,
  Legend,
  LinearScale,
  LineController,
  LineElement,
  PointElement,
  ScatterController,
  TimeScale,
  Tooltip,
} from "chart.js";
import priceBarPlugin from "./priceBarPlugin";

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
  priceBarPlugin,
);

export { Chart };
export type {
  ChartDataset,
  ChartOptions,
  LegendItem,
  Plugin,
  ScriptableContext,
  ScriptableLineSegmentContext,
} from "chart.js";
