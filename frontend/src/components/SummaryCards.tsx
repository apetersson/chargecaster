import type { SnapshotSummary } from "../types";
import { formatDate, formatNumber, formatPercent, statusClass } from "../utils/format";

const SummaryCards = ({ data }: { data: SnapshotSummary | null }) => {
  if (!data) {
    return null;
  }
  const { label, className } = statusClass(data.errors, data.warnings);

  const currentSoc = typeof data.current_soc_percent === "number" ? data.current_soc_percent : null;
  const recommendedSoc = typeof data.recommended_soc_percent === "number" ? data.recommended_soc_percent : null;

  let actionLabel = "Auto";
  if (currentSoc !== null && recommendedSoc !== null) {
    const delta = recommendedSoc - currentSoc;
    if (delta > 1) {
      actionLabel = "Charge";
    } else if (delta < -1) {
      actionLabel = "Discharge";
    } else {
      actionLabel = "Hold";
    }
  }

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
          <span className="label">Projected Savings</span>
          <span className="value small">{formatNumber(data.projected_savings_eur, " €")}</span>
        </div>
        <div className="metric">
          <span className="label">Projected Grid Power</span>
          <span className="value small">{formatNumber(data.projected_grid_energy_w, " W")}</span>
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
