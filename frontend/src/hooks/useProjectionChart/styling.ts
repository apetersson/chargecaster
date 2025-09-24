import type {
  ScriptableContext,
  ScriptableLineSegmentContext,
} from "chart.js";

import {
  GRID_BORDER,
  GRID_FILL,
  HISTORY_BORDER,
  HISTORY_FILL,
  HISTORY_POINT,
  PRICE_BORDER,
  PRICE_FILL,
  PRICE_HISTORY_BAR_BG,
  PRICE_HISTORY_BAR_BORDER,
  SOLAR_BORDER,
  SOLAR_FILL,
  SOC_BORDER,
  SOC_FILL,
} from "./constants";
import type { ProjectionPoint, SeriesSource } from "./types";

const isProjectionPoint = (value: unknown): value is ProjectionPoint =>
  Boolean(
    value &&
    typeof value === "object" &&
    "x" in value &&
    "source" in value,
  );

export const resolvePointColor = (
  context: ScriptableContext<"line">,
  accent: string,
  useAccentForHistory = false,
): string => {
  const raw = context.raw as ProjectionPoint | undefined;
  if (!raw || Number.isNaN(raw.y)) {
    return "rgba(0,0,0,0)";
  }
  if (raw.source === "history" && !useAccentForHistory) {
    return HISTORY_POINT;
  }
  return accent;
};

export const resolvePointRadius = (context: ScriptableContext<"line">): number => {
  const raw = context.raw as ProjectionPoint | undefined;
  if (!raw || Number.isNaN(raw.y)) {
    return 0;
  }
  return 3;
};

export const resolveHoverRadius = (context: ScriptableContext<"line">): number => {
  const raw = context.raw as ProjectionPoint | undefined;
  if (!raw || Number.isNaN(raw.y)) {
    return 0;
  }
  return 6;
};

type LineSegmentContext = ScriptableLineSegmentContext;

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

export const resolveSegmentBorder = (
  context: LineSegmentContext,
  accent: string,
  historyAccent: string = HISTORY_BORDER,
) => {
  const source = getSegmentSource(context);
  return source === "history" ? historyAccent : accent;
};

export const resolveSegmentBackground = (
  context: LineSegmentContext,
  accentFill: string,
  historyFill: string = HISTORY_FILL,
) => {
  const source = getSegmentSource(context);
  return source === "history" ? historyFill : accentFill;
};

export const resolveBarColors = (
  point: unknown,
  forecastColor: string,
  historyColor: string,
) => {
  if (!isProjectionPoint(point) || typeof point.y !== "number" || Number.isNaN(point.y)) {
    return "rgba(0,0,0,0)";
  }
  return point.source === "history" ? historyColor : forecastColor;
};

export const seriesStyles = {
  soc: {
    border: SOC_BORDER,
    fill: SOC_FILL,
  },
  grid: {
    border: GRID_BORDER,
    fill: GRID_FILL,
  },
  solar: {
    border: SOLAR_BORDER,
    fill: SOLAR_FILL,
  },
  price: {
    border: PRICE_BORDER,
    fill: PRICE_FILL,
    history: {
      fill: PRICE_HISTORY_BAR_BG,
      border: PRICE_HISTORY_BAR_BORDER,
    },
  },
  history: {
    border: HISTORY_BORDER,
    fill: HISTORY_FILL,
    point: HISTORY_POINT,
  },
};
