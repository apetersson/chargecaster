import { useEffect, useRef } from "react";
import { Chart, ChartConfiguration, registerables, type Point, type ScriptableContext, type ScriptableLineSegmentContext } from "chart.js";
import "chartjs-adapter-date-fns";

import type { HistoryPoint, TrajectoryPoint } from "../types";
import { dateTimeFormatter, numberFormatter, timeFormatter } from "../utils/format";

Chart.register(...registerables);

export function useProjectionChart(history: HistoryPoint[], trajectory: TrajectoryPoint[]) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    const hasHistory = Array.isArray(history) && history.length > 0;
    const hasTrajectory = Array.isArray(trajectory) && trajectory.length > 0;

    if (!hasHistory && !hasTrajectory) {
      chartRef.current?.destroy();
      chartRef.current = null;
      return undefined;
    }

    const nowDate = new Date();
    const historyWindowMs = 12 * 60 * 60 * 1000;
    const cutoffTime = nowDate.getTime() - historyWindowMs;

    const sortedHistory = hasHistory
      ? [...history]
          .map((item) => ({
            ...item,
            date: new Date(item.timestamp),
          }))
          .filter((item) => !Number.isNaN(item.date.getTime()) && item.date.getTime() >= cutoffTime)
          .sort((a, b) => a.date.getTime() - b.date.getTime())
      : [];

    const toPoint = (timestamp: number, value: number | null | undefined): Point => ({
      x: timestamp,
      y: typeof value === "number" ? value : Number.NaN,
    });

    const historySocPoints: Point[] = sortedHistory.map((item) =>
      toPoint(item.date.getTime(), item.battery_soc_percent)
    );
    const historyGridPoints: Point[] = sortedHistory.map((item) =>
      toPoint(item.date.getTime(), item.grid_energy_kwh)
    );
    const historyPricePoints: Point[] = sortedHistory.map((item) =>
      toPoint(item.date.getTime(), item.price_eur_per_kwh)
    );

    const futureSocPoints: Point[] = hasTrajectory
      ? trajectory
          .map((item) => {
            const startTime = new Date(item.start ?? item.end ?? "").getTime();
            if (Number.isNaN(startTime)) {
              return null;
            }
            const target =
              typeof item.soc_end_percent === "number"
                ? item.soc_end_percent
                : typeof item.soc_start_percent === "number"
                ? item.soc_start_percent
                : Number.NaN;
            return { x: startTime, y: target };
          })
          .filter((point): point is Point => point !== null)
          .sort((a, b) => a.x - b.x)
      : [];
    const futureGridPoints: Point[] = hasTrajectory
      ? trajectory
          .map((item) => {
            const startTime = new Date(item.start ?? item.end ?? "").getTime();
            if (Number.isNaN(startTime)) {
              return null;
            }
            return toPoint(startTime, item.grid_energy_kwh);
          })
          .filter((point): point is Point => point !== null)
          .sort((a, b) => a.x - b.x)
      : [];
    const futurePricePoints: Point[] = hasTrajectory
      ? trajectory
          .map((item) => {
            const startTime = new Date(item.start ?? item.end ?? "").getTime();
            if (Number.isNaN(startTime)) {
              return null;
            }
            return toPoint(startTime, item.price_eur_per_kwh);
          })
          .filter((point): point is Point => point !== null)
          .sort((a, b) => a.x - b.x)
      : [];

    const historyCount = sortedHistory.length;

    const priceValues = [...historyPricePoints, ...futurePricePoints]
      .map((point) => point.y)
      .filter((value): value is number => !Number.isNaN(value));
    const gridValues = [...historyGridPoints, ...futureGridPoints]
      .map((point) => point.y)
      .filter((value): value is number => !Number.isNaN(value));

    const priceMin = priceValues.length ? Math.min(0, ...priceValues) : 0;
    const priceMax = priceValues.length ? Math.max(0, ...priceValues) : 1;
    const gridMin = gridValues.length ? Math.min(0, ...gridValues) : 0;
    const gridMax = gridValues.length ? Math.max(0, ...gridValues) : 1;

    const nowMillis = nowDate.getTime();
    const buildSeries = (historyPoints: Point[], futurePoints: Point[]) => {
      const hasBreak = historyCount > 0 && futurePoints.length > 0;
      const data = hasBreak
        ? [...historyPoints, { x: nowMillis, y: Number.NaN }, ...futurePoints]
        : [...historyPoints, ...futurePoints];
      return { data, hasBreak };
    };

    const socSeries = buildSeries(historySocPoints, futureSocPoints);
    const gridSeries = buildSeries(historyGridPoints, futureGridPoints);
    const priceSeries = buildSeries(historyPricePoints, futurePricePoints);

    const xMinValue =
      historySocPoints[0]?.x ??
      futureSocPoints[0]?.x ??
      nowMillis;
    const xMaxValue =
      futureSocPoints[futureSocPoints.length - 1]?.x ||
      historySocPoints[historyCount - 1]?.x ||
      nowMillis;
    const firstMillis = xMinValue;
    const lastMillis = xMaxValue;

    const pastLineColor = "#94a3b8";
    const pastFillColor = "rgba(148, 163, 184, 0.2)";
    const pastPointColor = "#e2e8f0";

    const futureSocColor = "#22c55e";
    const futureSocFill = "rgba(34, 197, 94, 0.25)";
    const futureGridColor = "#f97316";
    const futureGridFill = "rgba(249, 115, 22, 0.15)";
    const futurePriceColor = "#38bdf8";
    const futurePriceFill = "rgba(56, 189, 248, 0.2)";

    const makeSegmentColor = (futureColor: string, futureFill: string) => ({
      borderColor: (ctx: ScriptableLineSegmentContext) =>
        ctx?.p0DataIndex !== undefined && ctx.p0DataIndex < historyCount
          ? pastLineColor
          : futureColor,
      backgroundColor: (ctx: ScriptableLineSegmentContext) =>
        ctx?.p0DataIndex !== undefined && ctx.p0DataIndex < historyCount
          ? pastFillColor
          : futureFill,
    });
    const pointColor = (
      ctx: ScriptableContext<"line">,
      futureColor: string,
      hasBreak: boolean
    ) => {
      if (hasBreak && ctx.dataIndex === historyCount) {
        return "transparent";
      }
      return ctx.dataIndex < historyCount ? pastPointColor : futureColor;
    };

    const pointRadius = (ctx: ScriptableContext<"line">, hasBreak: boolean) => {
      if (hasBreak && ctx.dataIndex === historyCount) {
        return 0;
      }
      return ctx.dataIndex < historyCount ? 3 : 4;
    };

    chartRef.current?.destroy();

    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }

    const config: ChartConfiguration<"line", Point[]> = {
      type: "line",
      data: {
        datasets: [
          {
            label: "Target SOC %",
            data: socSeries.data,
            parsing: false,
            borderColor: futureSocColor,
            backgroundColor: futureSocFill,
            yAxisID: "y",
            tension: 0.25,
            fill: true,
            spanGaps: true,
            segment: makeSegmentColor(futureSocColor, futureSocFill),
            pointRadius: (ctx: ScriptableContext<"line">) => pointRadius(ctx, socSeries.hasBreak),
            pointBackgroundColor: (ctx: ScriptableContext<"line">) =>
              pointColor(ctx, futureSocColor, socSeries.hasBreak),
            pointBorderColor: (ctx: ScriptableContext<"line">) =>
              pointColor(ctx, futureSocColor, socSeries.hasBreak),
          },
          {
            label: "Grid Energy (kWh)",
            data: gridSeries.data,
            parsing: false,
            borderColor: futureGridColor,
            backgroundColor: futureGridFill,
            yAxisID: "y1",
            tension: 0.2,
            spanGaps: true,
            segment: makeSegmentColor(futureGridColor, futureGridFill),
            pointRadius: (ctx: ScriptableContext<"line">) => pointRadius(ctx, gridSeries.hasBreak),
            pointBackgroundColor: (ctx: ScriptableContext<"line">) =>
              pointColor(ctx, futureGridColor, gridSeries.hasBreak),
            pointBorderColor: (ctx: ScriptableContext<"line">) =>
              pointColor(ctx, futureGridColor, gridSeries.hasBreak),
          },
          {
            label: "Price (€/kWh)",
            data: priceSeries.data,
            parsing: false,
            borderColor: futurePriceColor,
            backgroundColor: futurePriceFill,
            yAxisID: "y2",
            tension: 0.2,
            spanGaps: true,
            segment: makeSegmentColor(futurePriceColor, futurePriceFill),
            pointRadius: (ctx: ScriptableContext<"line">) => pointRadius(ctx, priceSeries.hasBreak),
            pointBackgroundColor: (ctx: ScriptableContext<"line">) =>
              pointColor(ctx, futurePriceColor, priceSeries.hasBreak),
            pointBorderColor: (ctx: ScriptableContext<"line">) =>
              pointColor(ctx, futurePriceColor, priceSeries.hasBreak),
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        scales: {
          x: {
            type: "time",
            min: xMinValue,
            time: {
              tooltipFormat: "dd MMM yyyy HH:mm",
              displayFormats: {
                hour: "HH:mm",
                minute: "HH:mm",
              },
            },
            ticks: {
              color: "#94a3b8",
              callback: (value) => {
                const millis = typeof value === "number" ? value : new Date(value).getTime();
                if (Math.abs(millis - firstMillis) < 60_000 || Math.abs(millis - lastMillis) < 60_000) {
                  return dateTimeFormatter.format(new Date(millis));
                }
                return timeFormatter.format(new Date(millis));
              },
            },
            grid: {
              color: "rgba(148, 163, 184, 0.1)",
            },
          },
          y: {
            type: "linear",
            position: "left",
            suggestedMin: 0,
            suggestedMax: 100,
            ticks: {
              callback: (value) => `${value}%`,
            },
          },
          y1: {
            type: "linear",
            position: "right",
            suggestedMin: gridMin === gridMax ? gridMin - 1 : gridMin,
            suggestedMax: gridMin === gridMax ? gridMax + 1 : gridMax,
            ticks: {
              callback: (value) => `${numberFormatter.format(Number(value))} kWh`,
            },
            grid: {
              drawOnChartArea: false,
            },
          },
          y2: {
            type: "linear",
            position: "right",
            suggestedMin: priceMin === priceMax ? priceMin - 0.1 : priceMin,
            suggestedMax: priceMin === priceMax ? priceMax + 0.1 : priceMax,
            grid: {
              drawOnChartArea: false,
            },
            ticks: {
              callback: (value) => `${numberFormatter.format(Number(value))} €/kWh`,
            },
            offset: true,
          },
        },
        plugins: {
          legend: {
            labels: {
              color: "#f8fafc",
            },
          },
        },
      },
    };

    chartRef.current = new Chart(canvas, config);

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [history, trajectory]);

  return canvasRef;
}
