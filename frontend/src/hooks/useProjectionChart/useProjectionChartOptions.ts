import { useMemo } from "react";

import { buildOptions } from "./buildOptions";
import type { AxisBounds, LegendGroup, TimeRange } from "./types";
import type { ChartOptions } from "./chartSetup";

export const useProjectionChartOptions = (
  bounds: { power: AxisBounds; price: AxisBounds },
  timeRange: TimeRange,
  legendGroups: LegendGroup[],
): ChartOptions<"line"> => {
  return useMemo(
    () => buildOptions({bounds, timeRange, legendGroups}),
    [bounds, timeRange, legendGroups],
  );
};
