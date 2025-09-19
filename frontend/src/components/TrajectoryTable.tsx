import type { TrajectoryPoint } from "../types";
import { formatDate, formatNumber, formatPercent } from "../utils/format";

type TrajectoryTableProps = {
  trajectory: TrajectoryPoint[];
};

const TrajectoryTable = ({ trajectory }: TrajectoryTableProps) => {
  if (!trajectory.length) {
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
            {trajectory.map((item) => {
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
