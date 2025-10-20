import { TimeSlot } from "@chargecaster/domain";
import type { ScatterDataPoint } from "chart.js";
import type { ForecastEra, OracleEntry } from "../../types";

export type SeriesSource = "history" | "forecast" | "gap";

export interface ProjectionPoint extends ScatterDataPoint {
  source: SeriesSource;
  xEnd?: number | null;
  isCurrentMarker?: boolean;
  // Optional strategy annotation for forecast price bars ("auto" | "charge" | "hold")
  // copied from OracleEntry["strategy"].
  strategy?: OracleEntry["strategy"];
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

export interface TimeRangeMs {
  min: number | null;
  max: number | null;
}
