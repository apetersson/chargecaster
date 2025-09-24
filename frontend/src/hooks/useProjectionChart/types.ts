import type { ScatterDataPoint } from "chart.js";
import type { ForecastEra, OracleEntry } from "../../types";
import { TimeSlot } from "@batteryctl/domain";

export type SeriesSource = "history" | "forecast" | "gap";

export interface ProjectionPoint extends ScatterDataPoint {
  source: SeriesSource;
  xEnd?: number | null;
  isCurrentMarker?: boolean;
}

export interface AxisBounds {
  min: number;
  max: number;
  dataMin: number | null;
  dataMax: number | null;
}

export interface DerivedEra {
  era: ForecastEra;
  oracle?: OracleEntry;
  slot: TimeSlot;
  startMs: number;
  endMs: number;
  priceCtPerKwh: number | null;
  solarAverageW: number | null;
}

export interface LegendGroup {
  label: string;
  color: string;
  datasetIndices: number[];
}

export interface TimeRange {
  min: number | null;
  max: number | null;
}
