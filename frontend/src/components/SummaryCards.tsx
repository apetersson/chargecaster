import type { SnapshotSummary } from "../types";
import { formatDate, formatNumber, formatPercent, statusClass } from "../utils/format";

const SummaryCards = ({data}: { data: SnapshotSummary | null }) => {
  if (!data) {
    return null;
  }
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
    return "";
  })();

  return (
    <section className="card">
      <div className="grid">
        <div className="metric strategy">
          <span className="label">Current Strategy</span>
          <span className="value strategy">{actionLabel}</span>
        </div>
        <div className="metric">
          <span className="label">Status</span>
          <span className={className}>{label}</span>
        </div>
        <div className="metric">
          <span className="label">Current SOC</span>
          <span className="value">{formatPercent(data.current_soc_percent)}</span>
        </div>
        <div className="metric">
          <span className="label">Baseline Cost</span>
          <span className="value small">{formatNumber(data.baseline_cost_eur, " €")}</span>
        </div>
        <div className="metric">
          <span className="label">Basic Battery Cost</span>
          <span className="value small">{formatNumber(data.basic_battery_cost_eur, " €")}</span>
        </div>
        <div className="metric">
          <span className="label">Price Snapshot</span>
          <span className="value small">
            {formatNumber(
              data.price_snapshot_ct_per_kwh ??
              (typeof data.price_snapshot_eur_per_kwh === "number"
                ? data.price_snapshot_eur_per_kwh * 100
                : null),
              " ct/kWh",
            )}
          </span>
        </div>
        <div className="metric">
          <span className="label">Projected Cost</span>
          <span className="value small">{formatNumber(data.projected_cost_eur, " €")}</span>
        </div>
        <div className="metric">
          <span className="label">PV/Battery Savings</span>
          <span className="value small">{formatNumber(data.projected_savings_eur, " €")}</span>
        </div>
        <div className="metric">
          <span className="label">Active Control Projected Savings</span>
          <span className="value small">{formatNumber(data.active_control_savings_eur, " €")}</span>
        </div>
        <div className="metric">
          <span className="label">Past 24h Savings</span>
          <span className="value small">{formatNumber(data.backtested_savings_eur, " €")}</span>
        </div>
        <div className="metric">
          <span className="label">Projected Grid Power</span>
          <span className="value small">{formatNumber(data.projected_grid_power_w, " W")}</span>
        </div>
        <div className="metric">
          <span className="label">Forecast Horizon</span>
          <span className="value small">{formatNumber(data.forecast_hours, " h")}</span>
        </div>
        <div className="metric">
          <span className="label">Forecast Samples</span>
          <span className="value small">{formatNumber(data.forecast_samples, " slots")}</span>
        </div>
      </div>
      <small className="timestamp">Last update: {formatDate(data.timestamp)}</small>
    </section>
  );
};

export default SummaryCards;
