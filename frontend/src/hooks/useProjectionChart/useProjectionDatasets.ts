import { useMemo } from "react";

import type { ForecastEra, HistoryPoint, OracleEntry, SnapshotSummary } from "../../types";
import { buildDatasets } from "./buildDatasets";
import type { AxisBounds, LegendGroup, ProjectionPoint, TimeRange } from "./types";
import type { ChartDataset } from "./chartSetup";

interface ProjectionDatasetResult {
  datasets: ChartDataset<"line", ProjectionPoint[]>[];
  bounds: {
    power: AxisBounds;
    price: AxisBounds;
  };
  timeRange: TimeRange;
  legendGroups: LegendGroup[];
}

export const useProjectionDatasets = (
  history: HistoryPoint[],
  forecast: ForecastEra[],
  oracleEntries: OracleEntry[],
  summary: SnapshotSummary | null,
): ProjectionDatasetResult => {
  return useMemo(
    () => buildDatasets(history, forecast, oracleEntries, summary),
    [
      history,
      forecast,
      oracleEntries,
      summary?.timestamp,
      summary?.current_soc_percent,
      summary?.next_step_soc_percent,
    ],
  );
};
