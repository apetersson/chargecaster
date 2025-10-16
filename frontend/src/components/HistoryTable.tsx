import type { HistoryPoint } from "../types";
import { formatDate, formatNumber, formatPercent } from "../utils/format";

type HistoryTableProps = {
  history: HistoryPoint[];
};

const HistoryTable = ({history}: HistoryTableProps) => {
  if (!history.length) {
    return null;
  }

  const rows = [...history].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return (
    <section className="card">
      <h2>Recent History</h2>
      <div className="table-wrapper">
        <table className="history-table">
          <colgroup>
            <col className="col-time"/>
            <col className="col-price"/>
            <col className="col-solar"/>
            <col className="col-power"/>
            <col className="col-soc"/>
            <col className="col-power"/>
          </colgroup>
          <thead>
          <tr>
            <th className="timestamp">Time</th>
            <th className="numeric">Price (ct/kWh)</th>
            <th className="numeric">Solar (W)</th>
            <th className="numeric">Demand (W)</th>
            <th className="numeric">Battery SOC %</th>
            <th className="numeric">Grid Power (W)</th>
          </tr>
          </thead>
          <tbody>
          {rows.map((item, idx) => (
            <tr key={`${item.timestamp}-${idx}`}>
              <td className="timestamp">{formatDate(item.timestamp)}</td>
              <td className="numeric">{formatNumber(item.price_ct_per_kwh, " ct/kWh")}</td>
              <td className="numeric">{formatNumber(item.solar_power_w, " W")}</td>
              <td className="numeric">{formatNumber(item.home_power_w, " W")}</td>
              <td className="numeric">{formatPercent(item.battery_soc_percent ?? null)}</td>
              <td className="numeric">{formatNumber(item.grid_power_w, " W")}</td>
            </tr>
          ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default HistoryTable;
