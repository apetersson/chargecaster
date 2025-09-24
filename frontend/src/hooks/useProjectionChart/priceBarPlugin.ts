import type { Plugin } from "chart.js";

import {
  DEFAULT_SLOT_DURATION_MS,
  PRICE_BORDER,
  PRICE_FILL,
  PRICE_HISTORY_BAR_BG,
  PRICE_HISTORY_BAR_BORDER,
} from "./constants";
import { resolveBarColors } from "./styling";
import type { ProjectionPoint } from "./types";

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

export default priceBarPlugin;
