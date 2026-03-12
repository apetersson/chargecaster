import { useMemo } from "react";

import type { DemandForecastEntry, ForecastEra, HistoryPoint, OracleEntry, SnapshotSummary } from "../../types";
import { buildDatasets } from "./buildDatasets";
import type { AxisBounds, LegendGroup, ProjectionPoint, TimeRangeMs } from "./types";
import type { ChartDataset } from "./chartSetup";

interface ProjectionDatasetResult {
  datasets: ChartDataset<"line", ProjectionPoint[]>[];
  bounds: {
    power: AxisBounds;
    price: AxisBounds;
  };
  timeRangeMs: TimeRangeMs;
  legendGroups: LegendGroup[];
}

export const useProjectionDatasets = (
  history: HistoryPoint[],
  forecast: ForecastEra[],
  demandForecast: DemandForecastEntry[],
  oracleEntries: OracleEntry[],
  summary: SnapshotSummary | null,
): ProjectionDatasetResult => {
  return useMemo(
    () => buildDatasets(history, forecast, demandForecast, oracleEntries, summary),
    [history, forecast, demandForecast, oracleEntries, summary],
  );
};
