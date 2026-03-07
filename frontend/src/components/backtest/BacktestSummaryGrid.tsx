import type { JSX } from "react";

import type { BacktestResult } from "../../types";
import { formatNumber } from "../../utils/format";

type BacktestSummaryGridProps = {
  data: BacktestResult;
};

function formatSignedNumber(value: number, unit = ""): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatNumber(Math.abs(value), unit)}`;
}

function BacktestSummaryGrid({ data }: BacktestSummaryGridProps): JSX.Element {
  const savingsPositive = data.savings_eur > 0;

  return (
    <div className="grid">
      <div className="metric">
        <span className="label">Actual Grid Cost</span>
        <span className="value small">{formatNumber(data.actual_total_cost_eur, " EUR")}</span>
      </div>
      <div className="metric">
        <span className="label">Auto Mode Cost</span>
        <span className="value small">{formatNumber(data.simulated_total_cost_eur, " EUR")}</span>
      </div>
      <div className="metric">
        <span className="label">Actual Final SOC</span>
        <span className="value small">{formatNumber(data.actual_final_soc_percent, "%")}</span>
      </div>
      <div className="metric">
        <span className="label">Auto Final SOC</span>
        <span className="value small">{formatNumber(data.simulated_final_soc_percent, "%")}</span>
      </div>
      <div className="metric">
        <span className="label">SOC Value Adj.</span>
        <span className="value small">{formatNumber(data.soc_value_adjustment_eur, " EUR")}</span>
      </div>
      <div className="metric">
        <span className="label">Adj. Actual Cost</span>
        <span className="value small">{formatNumber(data.adjusted_actual_cost_eur, " EUR")}</span>
      </div>
      <div className="metric">
        <span className="label">Adj. Auto Cost</span>
        <span className="value small">{formatNumber(data.adjusted_simulated_cost_eur, " EUR")}</span>
      </div>
      <div className="metric">
        <span className="label">Active Control Savings</span>
        <span className={`value small ${savingsPositive ? "positive" : "negative"}`}>
          {formatSignedNumber(data.savings_eur, " EUR")}
        </span>
      </div>
      <div className="metric">
        <span className="label">Marginal Discharge Price</span>
        <span className="value small">{formatNumber(data.avg_price_eur_per_kwh * 100, " ct/kWh")}</span>
      </div>
      <div className="metric">
        <span className="label">History Points</span>
        <span className="value small">{data.history_points_used}</span>
      </div>
    </div>
  );
}

export default BacktestSummaryGrid;
