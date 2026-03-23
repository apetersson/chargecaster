import type { JSX, ReactNode } from "react";

type MetricTileProps = {
  label: string;
  value: ReactNode;
  tone?: "default" | "positive" | "negative" | "brand";
  emphasis?: "headline" | "supporting";
};

function MetricTile({
  label,
  value,
  tone = "default",
  emphasis = "supporting",
}: MetricTileProps): JSX.Element {
  return (
    <div className={`metric-tile metric-tile-${emphasis}`}>
      <span className="metric-tile-label">{label}</span>
      <span className={`metric-tile-value metric-tile-tone-${tone}`}>{value}</span>
    </div>
  );
}

export default MetricTile;
