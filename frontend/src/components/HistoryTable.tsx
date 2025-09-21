import type { HistoryPoint } from "../types";
import { formatDate, formatNumber, formatPercent } from "../utils/format";

type HistoryTableProps = {
  history: HistoryPoint[];
};

const HistoryTable = ({ history }: HistoryTableProps) => {
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
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Battery SOC %</th>
              <th>Price (ct/kWh)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item, idx) => (
              <tr key={`${item.timestamp}-${idx}`}>
                <td>{formatDate(item.timestamp)}</td>
                <td>{formatPercent(item.battery_soc_percent ?? null)}</td>
                <td>{
                  typeof item.price_ct_per_kwh === "number"
                    ? formatNumber(item.price_ct_per_kwh, " ct/kWh")
                    : typeof item.price_eur_per_kwh === "number"
                      ? formatNumber(item.price_eur_per_kwh * 100, " ct/kWh")
                      : "n/a"
                }</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default HistoryTable;
