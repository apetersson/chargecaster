import type { DemandForecastEntry, ForecastEra, HistoryPoint, OracleEntry, SnapshotSummary } from "../../types";
import { useProjectionDatasets } from "./useProjectionDatasets";
import { useProjectionChartOptions } from "./useProjectionChartOptions";
import { useChartInstance } from "./useChartInstance";

export const useProjectionChart = (
  history: HistoryPoint[],
  forecast: ForecastEra[],
  demandForecast: DemandForecastEntry[],
  oracleEntries: OracleEntry[],
  summary: SnapshotSummary | null,
  options?: { isMobile?: boolean; showPowerAxisLabels?: boolean; showPriceAxisLabels?: boolean },
): ReturnType<typeof useChartInstance> => {
  const {datasets, bounds, timeRangeMs, legendGroups} = useProjectionDatasets(
    history,
    forecast,
    demandForecast,
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
