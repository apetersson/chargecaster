import type { JSX } from "react";

import type { BacktestResult } from "../../types";
import MetricGroupCard from "../metrics/MetricGroupCard";
import MetricTile from "../metrics/MetricTile";
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
  const savingsTone = savingsPositive ? "positive" : "negative";

  return (
    <>
      <MetricGroupCard title="Past Savings Result">
        <MetricTile
          label="Active Control Savings"
          value={formatSignedNumber(data.savings_eur, " EUR")}
          tone={savingsTone}
          emphasis="headline"
        />
        <MetricTile
          label="Adj. Actual Cost"
          value={formatNumber(data.adjusted_actual_cost_eur, " EUR")}
          emphasis="headline"
        />
        <MetricTile
          label="Adj. Auto Cost"
          value={formatNumber(data.adjusted_simulated_cost_eur, " EUR")}
          emphasis="headline"
        />
      </MetricGroupCard>

      <MetricGroupCard title="Past Cost Comparison">
        <MetricTile label="Actual Grid Cost" value={formatNumber(data.actual_total_cost_eur, " EUR")} />
        <MetricTile label="Auto Mode Cost" value={formatNumber(data.simulated_total_cost_eur, " EUR")} />
        <MetricTile label="History Points" value={data.history_points_used} />
        <MetricTile label="Span" value={formatNumber(data.span_hours, " h")} />
      </MetricGroupCard>

      <MetricGroupCard title="Past SOC Adjustment">
        <MetricTile label="Actual Final SOC" value={formatNumber(data.actual_final_soc_percent, "%")} />
        <MetricTile label="Auto Final SOC" value={formatNumber(data.simulated_final_soc_percent, "%")} />
        <MetricTile label="SOC Value Adj." value={formatNumber(data.soc_value_adjustment_eur, " EUR")} />
        <MetricTile label="Marginal Discharge Price" value={formatNumber(data.avg_price_eur_per_kwh * 100, " ct/kWh")} />
      </MetricGroupCard>
    </>
  );
}

export default BacktestSummaryGrid;
