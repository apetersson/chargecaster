import { useMemo } from "react";

import { buildOptions } from "./buildOptions";
import type { AxisBounds, LegendGroup, TimeRangeMs } from "./types";
import type { ChartOptions } from "./chartSetup";

export const useProjectionChartOptions = (
  bounds: { power: AxisBounds; price: AxisBounds },
  timeRangeMs: TimeRangeMs,
  legendGroups: LegendGroup[],
  responsive?: { isMobile?: boolean; showPowerAxisLabels?: boolean; showPriceAxisLabels?: boolean },
): ChartOptions<"line"> => {
  const isMobile = responsive?.isMobile;
  const showPowerAxisLabels = responsive?.showPowerAxisLabels;
  const showPriceAxisLabels = responsive?.showPriceAxisLabels;
  return useMemo(
    () => buildOptions({
      bounds,
      timeRangeMs,
      legendGroups,
      responsive: {
        isMobile,
        showPowerAxisLabels,
        showPriceAxisLabels,
      },
    }),
    [
      bounds,
      timeRangeMs,
      legendGroups,
      isMobile,
      showPowerAxisLabels,
      showPriceAxisLabels,
    ],
  );
};
