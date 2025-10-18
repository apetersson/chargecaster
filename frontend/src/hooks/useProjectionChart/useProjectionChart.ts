import type { ForecastEra, HistoryPoint, OracleEntry, SnapshotSummary } from "../../types";
import { useProjectionDatasets } from "./useProjectionDatasets";
import { useProjectionChartOptions } from "./useProjectionChartOptions";
import { useChartInstance } from "./useChartInstance";

export const useProjectionChart = (
  history: HistoryPoint[],
  forecast: ForecastEra[],
  oracleEntries: OracleEntry[],
  summary: SnapshotSummary | null,
  options?: { isMobile?: boolean; showPowerAxisLabels?: boolean; showPriceAxisLabels?: boolean },
) => {
  const {datasets, bounds, timeRangeMs, legendGroups} = useProjectionDatasets(
    history,
    forecast,
    oracleEntries,
    summary,
  );

  const chartOptions = useProjectionChartOptions(
    bounds,
    timeRangeMs,
    legendGroups,
    options,
  );

  return useChartInstance(datasets, chartOptions);
};

export type { ProjectionPoint, AxisBounds, LegendGroup } from "./types";
