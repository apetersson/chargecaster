import { useEffect, useRef, type MutableRefObject } from "react";

import { Chart, type ChartDataset, type ChartOptions } from "./chartSetup";
import type { ProjectionPoint } from "./types";

export const useChartInstance = (
  datasets: ChartDataset<"line", ProjectionPoint[]>[],
  options: ChartOptions<"line">,
): MutableRefObject<HTMLCanvasElement | null> => {
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

    if (chartInstance.current) {
      chartInstance.current.destroy();
      chartInstance.current = null;
    }

    const activeChart = Chart.getChart(canvas as HTMLCanvasElement | string);
    if (activeChart) {
      activeChart.destroy();
    }

    const chart = new Chart(context, {
      type: "line",
      data: {datasets},
      options,
    });

    chartInstance.current = chart;

    return () => {
      chart.destroy();
      chartInstance.current = null;
    };
  }, [datasets, options]);

  return canvasRef;
};
