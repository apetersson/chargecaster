import type { ForecastDerivedEra } from "@chargecaster/domain";
import type { ScatterDataPoint } from "chart.js";
import type { OracleEntry } from "../../types";

export type SeriesSource = "history" | "forecast" | "gap";

export interface ProjectionPoint extends ScatterDataPoint {
  source: SeriesSource;
  xEnd?: number | null;
  feedInY?: number | null;
  accurateY?: number | null;
  guesstimateY?: number | null;
  accurateProvider?: string | null;
  guesstimateProvider?: string | null;
  isCurrentMarker?: boolean;
  // Optional strategy annotation for forecast price bars.
  // copied from OracleEntry["strategy"].
  strategy?: OracleEntry["strategy"];
}

export interface AxisBounds {
  min: number;
  max: number;
  dataMin: number | null;
  dataMax: number | null;
}

export type DerivedEra = ForecastDerivedEra;

export interface LegendGroup {
  label: string;
  color: string;
  datasetIndices: number[];
}

export interface TimeRangeMs {
  min: number | null;
  max: number | null;
}
