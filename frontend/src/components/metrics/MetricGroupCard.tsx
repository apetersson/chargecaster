import type { JSX, ReactNode } from "react";

type MetricGroupCardProps = {
  title: string;
  children: ReactNode;
};

function MetricGroupCard({title, children}: MetricGroupCardProps): JSX.Element {
  return (
    <section className="metric-group-card">
      <h3 className="metric-group-title">{title}</h3>
      <div className="metric-group-grid">
        {children}
      </div>
    </section>
  );
}

export default MetricGroupCard;
