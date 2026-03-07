import { useMemo, type JSX } from "react";

import { useChartInstance } from "../hooks/useProjectionChart/useChartInstance";
import type { DailyBacktestDetail } from "../types";
import { formatNumber } from "../utils/format";
import {
  buildBacktestChartOptions,
  buildBacktestChartSeries,
} from "./backtest/backtestDetailChart";

interface DailyBacktestDetailChartProps {
  entry: DailyBacktestDetail;
}

function DailyBacktestDetailChart({ entry }: DailyBacktestDetailChartProps): JSX.Element {
  const { datasets, hasIntervals, pricePoints } = useMemo(
    () => buildBacktestChartSeries(entry),
    [entry],
  );
  const options = useMemo(
    () => buildBacktestChartOptions(pricePoints),
    [pricePoints],
  );
  const chartRef = useChartInstance(datasets, options);

  return (
    <div className="backtest-detail-panel">
      <div className="backtest-detail-summary">
        <span>Strategy: continuous</span>
        <span>Points: {entry.result.history_points_used}</span>
        <span>Start auto SOC: {formatNumber(entry.result.simulated_start_soc_percent, "%")}</span>
        <span>End auto SOC: {formatNumber(entry.result.simulated_final_soc_percent, "%")}</span>
        <span>Savings: {formatNumber(entry.result.savings_eur, " EUR")}</span>
      </div>
      {hasIntervals ? (
        <div className="chart-viewport history-detail-chart">
          <canvas ref={chartRef} aria-label={`Backtest detail for ${entry.date}`} />
        </div>
      ) : (
        <p className="status">No interval detail available for this day.</p>
      )}
    </div>
  );
}

export default DailyBacktestDetailChart;
