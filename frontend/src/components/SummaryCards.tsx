import type { JSX } from "react";

import type { SnapshotSummary } from "../types";
import { formatDate, formatNumber, formatPercent, formatSignedNumber, formatTimeRange, statusClass } from "../utils/format";
import type { UseBacktestHistoryState } from "../hooks/useBacktestHistory";
import SectionCardHeader from "./common/SectionCardHeader";
import BacktestSummaryGrid from "./backtest/BacktestSummaryGrid";
import MetricGroupCard from "./metrics/MetricGroupCard";
import MetricTile from "./metrics/MetricTile";

function SummaryCards({
  data,
  backtestState,
}: {
  data: SnapshotSummary | null;
  backtestState: UseBacktestHistoryState;
}): JSX.Element | null {
  if (!data) {
    return null;
  }
  const {
    backtest,
    backtestLoading,
    backtestError,
    refreshBacktest,
  } = backtestState;
  const {label, className} = statusClass(data.errors, data.warnings);

  const currentMode = data.current_mode ?? null;
  const actionLabel = (() => {
    if (currentMode === "charge") {
      return "Charge";
    }
    if (currentMode === "auto") {
      return "Auto";
    }
    if (currentMode === "hold") {
      return "Hold";
    }
    if (currentMode === "limit") {
      return "Limit";
    }
    return "";
  })();
  const peakSolarAdjustmentLabel = (() => {
    const base = formatSignedNumber(data.solar_forecast_discrepancy_w, " W");
    const range = formatTimeRange(
      data.solar_forecast_discrepancy_start,
      data.solar_forecast_discrepancy_end,
    );
    return range === "n/a" ? base : `${base} (${range})`;
  })();
  const batteryEfficiencyLabel = (() => {
    const charge = formatPercent(data.charge_efficiency_percent);
    const discharge = formatPercent(data.discharge_efficiency_percent);
    if (charge === "n/a" && discharge === "n/a") {
      return "n/a";
    }
    return `${charge}/${discharge}`;
  })();
  const projectedSavingsTone = (data.projected_savings_eur ?? 0) >= 0 ? "positive" : "negative";
  const activeControlSavingsTone = (data.active_control_savings_eur ?? 0) >= 0 ? "positive" : "negative";

  return (
    <section className="card">
      <SectionCardHeader
        title="Future Plan and Past Savings"
        subtitle="Forecast-based strategy and projected outcome, plus historical savings evidence."
        actions={(
          <button
            type="button"
            className="refresh-button"
            onClick={refreshBacktest}
            disabled={backtestLoading}
          >
            {backtestLoading ? "Refreshing savings..." : "Refresh savings"}
          </button>
        )}
      />
      <div className="metric-groups-grid">
        <MetricGroupCard title="Future Decision">
          <MetricTile label="Current Strategy" value={actionLabel || "n/a"} tone="brand" emphasis="headline" />
          <MetricTile label="Current SOC" value={formatPercent(data.current_soc_percent)} emphasis="headline" />
          <MetricTile label="Status" value={<span className={className}>{label}</span>} />
          <MetricTile
            label="Price Snapshot"
            value={formatNumber(
              data.price_snapshot_ct_per_kwh ??
              (data.price_snapshot_eur_per_kwh != null
                ? data.price_snapshot_eur_per_kwh * 100
                : null),
              " ct/kWh",
            )}
          />
        </MetricGroupCard>

        <MetricGroupCard title="Future Outcome">
          <MetricTile label="Projected Cost" value={formatNumber(data.projected_cost_eur, " €")} emphasis="headline" />
          <MetricTile label="PV/Battery Savings" value={formatNumber(data.projected_savings_eur, " €")} tone={projectedSavingsTone} />
          <MetricTile
            label="Active Control Projected Savings"
            value={formatNumber(data.active_control_savings_eur, " €")}
            tone={activeControlSavingsTone}
            emphasis="headline"
          />
          <MetricTile label="Expected Feed-in" value={formatNumber(data.expected_feed_in_kwh, " kWh")} />
          <MetricTile label="Baseline Cost" value={formatNumber(data.baseline_cost_eur, " €")} />
          <MetricTile label="Basic Battery Cost" value={formatNumber(data.basic_battery_cost_eur, " €")} />
        </MetricGroupCard>

        <MetricGroupCard title="Live System Context">
          <MetricTile label="Charge/Discharge Eff." value={batteryEfficiencyLabel} />
          <MetricTile label="Projected Grid Power" value={formatNumber(data.projected_grid_power_w, " W")} />
          <MetricTile
            label="Grid Fee"
            value={formatNumber(
              data.grid_fee_eur_per_kwh != null
                ? data.grid_fee_eur_per_kwh * 100
                : null,
              " ct/kWh",
            )}
          />
        </MetricGroupCard>

        <MetricGroupCard title="Future Forecast Context">
          <MetricTile label="Forecast Horizon" value={formatNumber(data.forecast_hours, " h")} />
          <MetricTile label="Forecast Samples" value={formatNumber(data.forecast_samples, " slots")} />
          <MetricTile label="Peak Solar Adj." value={peakSolarAdjustmentLabel} />
          <MetricTile label="Last update" value={formatDate(data.timestamp)} />
        </MetricGroupCard>

        {backtestError ? (
          <MetricGroupCard title="Past Savings Check">
            <MetricTile label="Status" value={<span className="status err">{backtestError}</span>} />
          </MetricGroupCard>
        ) : !backtest || backtest.history_points_used < 2 ? (
          <MetricGroupCard title="Past Savings Check">
            <MetricTile
              label="Status"
              value={backtestLoading ? "Loading..." : "Not enough history data"}
            />
          </MetricGroupCard>
        ) : (
          <BacktestSummaryGrid data={backtest} />
        )}
      </div>
    </section>
  );
}

export default SummaryCards;
