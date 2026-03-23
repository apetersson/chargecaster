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

    let resizeTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const triggerResize = (): void => {
      const active = chartInstance.current;
      if (!active) {
        return;
      }
      active.resize();
      active.update("none");
    };
    const scheduleResize = (): void => {
      if (resizeTimeoutId) {
        clearTimeout(resizeTimeoutId);
      }
      requestAnimationFrame(() => {
        triggerResize();
      });
      resizeTimeoutId = setTimeout(() => {
        triggerResize();
      }, 180);
    };
    const handleVisibilityChange = (): void => {
      if (document.visibilityState === "visible") {
        scheduleResize();
      }
    };
    const handlePageShow = (): void => {
      scheduleResize();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("focus", handlePageShow);
    window.visualViewport?.addEventListener("resize", handlePageShow);

    return () => {
      if (resizeTimeoutId) {
        clearTimeout(resizeTimeoutId);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("focus", handlePageShow);
      window.visualViewport?.removeEventListener("resize", handlePageShow);
      chart.destroy();
      chartInstance.current = null;
    };
  }, [datasets, options]);

  return canvasRef;
};
