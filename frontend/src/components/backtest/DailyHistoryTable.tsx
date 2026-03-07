import { Fragment, type JSX } from "react";

import type { DailyBacktestDetail, DailyBacktestEntry } from "../../types";
import { formatNumber } from "../../utils/format";
import DailyBacktestDetailChart from "../DailyBacktestDetailChart";

type DailyHistoryTableProps = {
  entries: DailyBacktestEntry[] | null;
  hasMore: boolean;
  loading: boolean;
  loadingAll: boolean;
  error: string | null;
  expandedDate: string | null;
  detailByDate: Partial<Record<string, DailyBacktestDetail>>;
  detailLoadingDate: string | null;
  detailErrorByDate: Partial<Record<string, string>>;
  onRefresh: () => void;
  onLoadMore: () => void;
  onLoadAll: () => void;
  onToggleDetail: (date: string) => void;
};

function formatSignedNumber(value: number, unit = ""): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatNumber(Math.abs(value), unit)}`;
}

function DailyHistoryTable({
  entries,
  hasMore,
  loading,
  loadingAll,
  error,
  expandedDate,
  detailByDate,
  detailLoadingDate,
  detailErrorByDate,
  onRefresh,
  onLoadMore,
  onLoadAll,
  onToggleDetail,
}: DailyHistoryTableProps): JSX.Element {
  const dividerStyle = {
    marginTop: "1rem",
    borderTop: "1px solid var(--border, #333)",
    paddingTop: "1rem",
  };

  if (error) {
    return (
      <div style={dividerStyle}>
        <p className="status err">{error}</p>
      </div>
    );
  }

  if (!entries || entries.length === 0) {
    return (
      <div style={dividerStyle}>
        <p className="status">{loading ? "Computing..." : "No full calendar days in history yet."}</p>
      </div>
    );
  }

  const totalSavings = entries.reduce((sum, entry) => sum + entry.result.savings_eur, 0);

  return (
    <div style={dividerStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>Daily History ({entries.length} days)</span>
        <button
          type="button"
          className="refresh-button"
          onClick={onRefresh}
          disabled={loading}
          style={{ fontSize: "0.75rem", padding: "4px 8px" }}
        >
          {loading ? "..." : "Refresh"}
        </button>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.78rem" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border, #333)", textAlign: "right" }}>
              <th style={{ textAlign: "left", padding: "4px 6px", fontWeight: 500 }}>Date</th>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>Pts</th>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>Actual EUR</th>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>Auto EUR</th>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>Adj. Actual</th>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>Adj. Auto</th>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>Actual SOC</th>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>Auto SOC</th>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>SOC Adj EUR</th>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>Marginal ct/kWh</th>
              <th style={{ padding: "4px 6px", fontWeight: 500 }}>Savings</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(({ date, result }) => {
              const expanded = expandedDate === date;
              const detail = detailByDate[date];
              const detailError = detailErrorByDate[date];
              const detailLoading = detailLoadingDate === date;
              const positiveSavings = result.savings_eur > 0;

              return (
                <Fragment key={date}>
                  <tr
                    className={`backtest-history-row ${expanded ? "expanded" : ""}`}
                    style={{ borderBottom: "1px solid var(--border-subtle, #222)" }}
                    onClick={() => {
                      onToggleDetail(date);
                    }}
                  >
                    <td style={{ padding: "4px 6px" }}>{date}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{result.history_points_used}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{formatNumber(result.actual_total_cost_eur, "")}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{formatNumber(result.simulated_total_cost_eur, "")}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{formatNumber(result.adjusted_actual_cost_eur, "")}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{formatNumber(result.adjusted_simulated_cost_eur, "")}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{formatNumber(result.actual_final_soc_percent, "%")}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{formatNumber(result.simulated_final_soc_percent, "%")}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{formatNumber(result.soc_value_adjustment_eur, "")}</td>
                    <td style={{ padding: "4px 6px", textAlign: "right" }}>{formatNumber(result.avg_price_eur_per_kwh * 100, "")}</td>
                    <td
                      style={{
                        padding: "4px 6px",
                        textAlign: "right",
                        color: positiveSavings ? "var(--positive, #4caf50)" : "var(--negative, #f44336)",
                      }}
                    >
                      {formatSignedNumber(result.savings_eur)}
                    </td>
                  </tr>
                  {expanded ? (
                    <tr className="backtest-detail-row">
                      <td colSpan={11} style={{ padding: "0.75rem 0.75rem 1rem" }}>
                        {detailLoading ? <p className="status">Loading day curve...</p> : null}
                        {!detailLoading && detailError ? <p className="status err">{detailError}</p> : null}
                        {!detailLoading && !detailError && detail ? <DailyBacktestDetailChart entry={detail} /> : null}
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: "1px solid var(--border, #333)", fontWeight: 600 }}>
              <td colSpan={10} style={{ padding: "4px 6px", textAlign: "right" }}>Total savings</td>
              <td
                style={{
                  padding: "4px 6px",
                  textAlign: "right",
                  color: totalSavings > 0 ? "var(--positive, #4caf50)" : "var(--negative, #f44336)",
                }}
              >
                {formatSignedNumber(totalSavings, " EUR")}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {hasMore ? (
        <div style={{ marginTop: "0.5rem", textAlign: "center", display: "flex", justifyContent: "center", gap: "0.6rem", flexWrap: "wrap" }}>
          <button
            type="button"
            className="refresh-button"
            onClick={onLoadMore}
            disabled={loading}
            style={{ fontSize: "0.75rem", padding: "4px 12px" }}
          >
            {loading && !loadingAll ? "..." : "Load more"}
          </button>
          <button
            type="button"
            className="refresh-button"
            onClick={onLoadAll}
            disabled={loading}
            style={{ fontSize: "0.75rem", padding: "4px 12px" }}
          >
            {loadingAll ? "..." : "Load all"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default DailyHistoryTable;
