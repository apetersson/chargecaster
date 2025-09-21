import type { TrajectoryPoint } from "../types";
import { formatDate, formatNumber, formatPercent } from "../utils/format";

type TrajectoryTableProps = {
  trajectory: TrajectoryPoint[];
};

const TrajectoryTable = ({ trajectory }: TrajectoryTableProps) => {
  const now = Date.now();
  const rows = trajectory
    .filter((item) => {
      const start = new Date(item.start).getTime();
      const end = new Date(item.end).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        return false;
      }
      if (end <= now) {
        return false;
      }
      return start > now;
    })
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());

  if (!rows.length) {
    return (
      <section className="card">
        <p>No trajectory data available.</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Forecast Horizon</h2>
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Slot</th>
              <th>Start</th>
              <th>End</th>
              <th>Target SOC %</th>
              <th>Grid Energy (kWh)</th>
              <th>Price (€/kWh)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item) => {
              const target = item.soc_end_percent ?? item.soc_start_percent;
              return (
                <tr key={item.slot_index}>
                  <td>{item.slot_index}</td>
                  <td>{formatDate(item.start)}</td>
                  <td>{formatDate(item.end)}</td>
                  <td>{formatPercent(target)}</td>
                  <td>{formatNumber(item.grid_energy_kwh)}</td>
                  <td>{formatNumber(item.price_eur_per_kwh)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default TrajectoryTable;
