import type { ForecastEra, HistoryPoint, OracleEntry, SnapshotSummary } from "../../types";
import { useProjectionDatasets } from "./useProjectionDatasets";
import { useProjectionChartOptions } from "./useProjectionChartOptions";
import { useChartInstance } from "./useChartInstance";

export const useProjectionChart = (
  history: HistoryPoint[],
  forecast: ForecastEra[],
  oracleEntries: OracleEntry[],
  summary: SnapshotSummary | null,
) => {
  const {datasets, bounds, timeRange, legendGroups} = useProjectionDatasets(
    history,
    forecast,
    oracleEntries,
    summary,
  );

  const options = useProjectionChartOptions(bounds, timeRange, legendGroups);

  return useChartInstance(datasets, options);
};

export type { ProjectionPoint, AxisBounds, LegendGroup } from "./types";
