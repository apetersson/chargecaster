import type { Plugin } from "chart.js";

import {
  DEFAULT_SLOT_DURATION_MS,
  FEED_IN_PRICE_BORDER,
  FEED_IN_PRICE_FILL,
  FEED_IN_PRICE_HISTORY_BAR_BG,
  FEED_IN_PRICE_HISTORY_BAR_BORDER,
  PRICE_BORDER,
  PRICE_BORDER_AUTO,
  PRICE_BORDER_CHARGE,
  PRICE_BORDER_HOLD,
  PRICE_FILL,
  PRICE_FILL_AUTO,
  PRICE_FILL_CHARGE,
  PRICE_FILL_HOLD,
  GRID_FEE_MARKER,
  PRICE_HISTORY_BAR_BG,
  PRICE_HISTORY_BAR_BORDER,
} from "./constants";
import { resolveBarColors } from "./styling";
import type { ProjectionPoint } from "./types";

const priceBarPlugin: Plugin = {
  id: "price-bar-plugin",
  beforeDatasetsDraw: function (chart) {
    const ctx = chart.ctx;
    if (!("x" in chart.scales) || !("price" in chart.scales)) {
      return;
    }
    const xScale = chart.scales.x;
    const yScale = chart.scales.price;

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
        const feedInValue = point.feedInY;
        const hasImportBar = Number.isFinite(value);
        const hasFeedInBar = Number.isFinite(feedInValue);
        if (!hasImportBar && !hasFeedInBar) {
          continue;
        }
        const startValue = point.x;
        if (Number.isNaN(startValue)) {
          continue;
        }
        const endValue = typeof point.xEnd === "number" && Number.isFinite(point.xEnd)
          ? point.xEnd
          : startValue + DEFAULT_SLOT_DURATION_MS;
        const left = xScale.getPixelForValue(startValue);
        const right = xScale.getPixelForValue(endValue);
        const base = yScale.getPixelForValue(0);

        const barLeft = Math.min(left, right);
        const barWidth = Math.max(1, Math.abs(right - left));
        const barCount = hasImportBar && hasFeedInBar ? 2 : 1;
        const innerGap = barCount === 2 ? Math.min(4, barWidth * 0.08) : 0;
        const segmentWidth = Math.max(1, (barWidth - innerGap) / barCount);

        // Pick forecast color by oracle strategy: auto -> pinkish blue, charge -> greenish blue
        const forecastFill: string =
          point.strategy === "charge"
            ? PRICE_FILL_CHARGE
            : point.strategy === "auto"
              ? PRICE_FILL_AUTO
              : point.strategy === "limit"
                ? PRICE_FILL_HOLD
              : point.strategy === "hold"
                ? PRICE_FILL_HOLD
                : PRICE_FILL;
        const forecastBorder: string = point.strategy === "charge"
          ? PRICE_BORDER_CHARGE
          : point.strategy === "auto"
            ? PRICE_BORDER_AUTO
            : point.strategy === "limit"
              ? PRICE_BORDER_HOLD
            : point.strategy === "hold"
              ? PRICE_BORDER_HOLD
              : PRICE_BORDER;

        const drawBar = (
          barValue: number,
          leftPx: number,
          widthPx: number,
          fillColor: string,
          borderColor: string,
        ): void => {
          const top = yScale.getPixelForValue(barValue);
          const barTop = Math.min(top, base);
          const barHeight = Math.max(1, Math.abs(base - top));
          ctx.save();
          ctx.fillStyle = fillColor;
          ctx.strokeStyle = borderColor;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.rect(leftPx, barTop, widthPx, barHeight);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        };

        const drawGridFeeMarker = (
          markerValue: number,
          leftPx: number,
          widthPx: number,
        ): void => {
          const markerTop = yScale.getPixelForValue(markerValue);
          const inset = Math.max(2, Math.min(6, widthPx * 0.18));
          const lineLeft = leftPx + inset;
          const lineRight = leftPx + widthPx - inset;
          ctx.save();
          ctx.strokeStyle = GRID_FEE_MARKER;
          ctx.lineWidth = Math.max(1, Math.min(2, widthPx * 0.08));
          ctx.beginPath();
          ctx.moveTo(lineLeft, markerTop);
          ctx.lineTo(lineRight, markerTop);
          ctx.stroke();
          ctx.restore();
        };

        if (hasImportBar) {
          drawBar(
            value,
            barLeft,
            segmentWidth,
            resolveBarColors(point, forecastFill, PRICE_HISTORY_BAR_BG),
            resolveBarColors(point, forecastBorder, PRICE_HISTORY_BAR_BORDER),
          );
          if (point.source === "forecast" && typeof point.gridFeeY === "number" && Number.isFinite(point.gridFeeY) && point.gridFeeY > 0) {
            drawGridFeeMarker(point.gridFeeY, barLeft, segmentWidth);
          }
        }

        if (hasFeedInBar) {
          const feedInLeft = hasImportBar ? barLeft + segmentWidth + innerGap : barLeft;
          const normalizedFeedInValue = point.feedInY;
          if (typeof normalizedFeedInValue !== "number" || !Number.isFinite(normalizedFeedInValue)) {
            continue;
          }
          drawBar(
            normalizedFeedInValue,
            feedInLeft,
            segmentWidth,
            resolveBarColors(point, FEED_IN_PRICE_FILL, FEED_IN_PRICE_HISTORY_BAR_BG),
            resolveBarColors(point, FEED_IN_PRICE_BORDER, FEED_IN_PRICE_HISTORY_BAR_BORDER),
          );
        }
      }
    });
  },
};

export default priceBarPlugin;
