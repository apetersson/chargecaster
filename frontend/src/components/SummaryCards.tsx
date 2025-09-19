import type { SnapshotPayload } from "../types";
import { formatDate, formatNumber, formatPercent, statusClass } from "../utils/format";

const SummaryCards = ({ data }: { data: SnapshotPayload | null }) => {
  if (!data) {
    return null;
  }
  const { label, className } = statusClass(data.errors, data.warnings);

  const hasCommand = typeof data.recommended_soc_percent === "number";
  const actionLabel = (() => {
    if (!hasCommand) {
      return "No action";
    }
    const current = data.current_soc_percent ?? 0;
    const next = data.next_step_soc_percent ?? current;
    const target = data.recommended_final_soc_percent ?? data.recommended_soc_percent ?? next;
    if (target > current + 0.5) {
      return `Charge towards ${formatPercent(target)}`;
    }
    if (target < current - 0.5) {
      return `Discharge towards ${formatPercent(target)}`;
    }
    if (next > current + 0.5) {
      return `Increase SOC towards ${formatPercent(next)}`;
    }
    if (next < current - 0.5) {
      return `Lower SOC towards ${formatPercent(next)}`;
    }
    return `Hold around ${formatPercent(current)}`;
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
          <span className="label">Next Target</span>
          <span className="value">{formatPercent(data.next_step_soc_percent)}</span>
        </div>
        <div className="metric">
          <span className="label">Recommended Final</span>
          <span className="value">{formatPercent(data.recommended_final_soc_percent)}</span>
        </div>
        <div className="metric">
          <span className="label">Current Strategy</span>
          <span className="value small">{actionLabel}</span>
        </div>
        <div className="metric">
          <span className="label">Price Snapshot</span>
          <span className="value small">{formatNumber(Number(data.price_snapshot_eur_per_kwh), " €/kWh")}</span>
        </div>
        <div className="metric">
          <span className="label">Projected Cost</span>
          <span className="value small">{formatNumber(data.projected_cost_eur, " €")}</span>
        </div>
        <div className="metric">
          <span className="label">Projected Grid Energy</span>
          <span className="value small">{formatNumber(data.projected_grid_energy_kwh, " kWh")}</span>
        </div>
      </div>
      <small className="timestamp">Last update: {formatDate(data.timestamp)}</small>
    </section>
  );
};

export default SummaryCards;
