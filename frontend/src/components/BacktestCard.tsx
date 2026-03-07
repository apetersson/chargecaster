import { useCallback, useEffect, useState, type JSX } from "react";

import { trpcClient } from "../api/trpc";
import { formatNumber } from "../utils/format";

interface BacktestResult {
  generated_at: string;
  actual_total_cost_eur: number;
  simulated_total_cost_eur: number;
  actual_final_soc_percent: number;
  simulated_final_soc_percent: number;
  soc_value_adjustment_eur: number;
  adjusted_actual_cost_eur: number;
  adjusted_simulated_cost_eur: number;
  savings_eur: number;
  avg_price_eur_per_kwh: number;
  history_points_used: number;
  span_hours: number;
}

interface DailyBacktestEntry {
  date: string;
  result: BacktestResult;
}

interface DailyBacktestPage {
  entries: DailyBacktestEntry[];
  hasMore: boolean;
}

const dashboard = trpcClient.dashboard as Record<string, unknown> as {
  backtest: { query: () => Promise<BacktestResult> };
  backtestHistory: { query: (input: { limit: number; skip: number }) => Promise<DailyBacktestPage> };
};

function BacktestCard(): JSX.Element | null {
  const [data, setData] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dailyEntries, setDailyEntries] = useState<DailyBacktestEntry[] | null>(null);
  const [dailyHasMore, setDailyHasMore] = useState(false);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyError, setDailyError] = useState<string | null>(null);

  const fetchBacktest = useCallback(() => {
    const run = async () => {
      try {
        setLoading(true);
        setError(null);
        const result = await dashboard.backtest.query();
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load backtest");
      } finally {
        setLoading(false);
      }
    };
    void run();
  }, []);

  const loadDailyPage = useCallback((skip: number) => {
    const run = async () => {
      try {
        setDailyLoading(true);
        setDailyError(null);
        const page = await dashboard.backtestHistory.query({ limit: 7, skip });
        setDailyEntries((prev) => (skip === 0 ? page.entries : [...(prev ?? []), ...page.entries]));
        setDailyHasMore(page.hasMore);
      } catch (err) {
        setDailyError(err instanceof Error ? err.message : "Failed to load daily history");
      } finally {
        setDailyLoading(false);
      }
    };
    void run();
  }, []);

  useEffect(() => {
    void fetchBacktest();
  }, [fetchBacktest]);

  if (error) {
    return (
      <section className="card">
        <h2>Backtest (24h)</h2>
        <p className="status err">{error}</p>
      </section>
    );
  }

  if (!data || data.history_points_used < 2) {
    return (
      <section className="card">
        <h2>Backtest (24h)</h2>
        <p className="status">{loading ? "Loading..." : "Not enough history data"}</p>
      </section>
    );
  }

  const savingsPositive = data.savings_eur > 0;

  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Backtest vs Auto ({formatNumber(data.span_hours, "h")} span)</h2>
        <button
          type="button"
          className="refresh-button"
          onClick={fetchBacktest}
          disabled={loading}
          style={{ fontSize: "0.75rem", padding: "4px 8px" }}
        >
          {loading ? "..." : "Refresh"}
        </button>
      </div>
      <div className="grid">
        <div className="metric">
          <span className="label">Actual Grid Cost</span>
          <span className="value small">{formatNumber(data.actual_total_cost_eur, " EUR")}</span>
        </div>
        <div className="metric">
          <span className="label">Auto Mode Cost</span>
          <span className="value small">{formatNumber(data.simulated_total_cost_eur, " EUR")}</span>
        </div>
        <div className="metric">
          <span className="label">Actual Final SOC</span>
          <span className="value small">{formatNumber(data.actual_final_soc_percent, "%")}</span>
        </div>
        <div className="metric">
          <span className="label">Auto Final SOC</span>
          <span className="value small">{formatNumber(data.simulated_final_soc_percent, "%")}</span>
        </div>
        <div className="metric">
          <span className="label">SOC Value Adj.</span>
          <span className="value small">{formatNumber(data.soc_value_adjustment_eur, " EUR")}</span>
        </div>
        <div className="metric">
          <span className="label">Adj. Actual Cost</span>
          <span className="value small">{formatNumber(data.adjusted_actual_cost_eur, " EUR")}</span>
        </div>
        <div className="metric">
          <span className="label">Adj. Auto Cost</span>
          <span className="value small">{formatNumber(data.adjusted_simulated_cost_eur, " EUR")}</span>
        </div>
        <div className="metric">
          <span className="label">Active Control Savings</span>
          <span className={`value small ${savingsPositive ? "" : "negative"}`}>
            {savingsPositive ? "-" : "+"}{formatNumber(Math.abs(data.savings_eur), " EUR")}
          </span>
        </div>
        <div className="metric">
          <span className="label">Marginal Discharge Price</span>
          <span className="value small">{formatNumber(data.avg_price_eur_per_kwh * 100, " ct/kWh")}</span>
        </div>
        <div className="metric">
          <span className="label">History Points</span>
          <span className="value small">{data.history_points_used}</span>
        </div>
      </div>

      <DailyHistorySection
        entries={dailyEntries}
        hasMore={dailyHasMore}
        loading={dailyLoading}
        error={dailyError}
        onLoad={() => { loadDailyPage(0); }}
        onLoadMore={() => { loadDailyPage(dailyEntries?.length ?? 0); }}
      />
    </section>
  );
}

interface DailyHistorySectionProps {
  entries: DailyBacktestEntry[] | null;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  onLoad: () => void;
  onLoadMore: () => void;
}

function DailyHistorySection({ entries, hasMore, loading, error, onLoad, onLoadMore }: DailyHistorySectionProps): JSX.Element {
  const dividerStyle = { marginTop: "1rem", borderTop: "1px solid var(--border, #333)", paddingTop: "1rem" };

  if (!entries && !loading && !error) {
    return (
      <div style={dividerStyle}>
        <button type="button" className="refresh-button" onClick={onLoad} style={{ fontSize: "0.75rem", padding: "4px 10px" }}>
          Load Daily History
        </button>
      </div>
    );
  }

  if (error) {
    return <div style={dividerStyle}><p className="status err">{error}</p></div>;
  }

  if (!entries || entries.length === 0) {
    return (
      <div style={dividerStyle}>
        <p className="status">{loading ? "Computing..." : "No full calendar days in history yet."}</p>
      </div>
    );
  }

  const totalSavings = entries.reduce((sum, d) => sum + d.result.savings_eur, 0);

  return (
    <div style={dividerStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <span style={{ fontSize: "0.85rem", fontWeight: 600 }}>Daily History ({entries.length} days)</span>
        <button type="button" className="refresh-button" onClick={onLoad} disabled={loading} style={{ fontSize: "0.75rem", padding: "4px 8px" }}>
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
              const pos = result.savings_eur > 0;
              return (
                <tr key={date} style={{ borderBottom: "1px solid var(--border-subtle, #222)" }}>
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
                  <td style={{ padding: "4px 6px", textAlign: "right", color: pos ? "var(--positive, #4caf50)" : "var(--negative, #f44336)" }}>
                    {pos ? "-" : "+"}{formatNumber(Math.abs(result.savings_eur), "")}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: "1px solid var(--border, #333)", fontWeight: 600 }}>
              <td colSpan={10} style={{ padding: "4px 6px", textAlign: "right" }}>Total savings</td>
              <td style={{ padding: "4px 6px", textAlign: "right", color: totalSavings > 0 ? "var(--positive, #4caf50)" : "var(--negative, #f44336)" }}>
                {totalSavings > 0 ? "-" : "+"}{formatNumber(Math.abs(totalSavings), " EUR")}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {hasMore ? (
        <div style={{ marginTop: "0.5rem", textAlign: "center" }}>
          <button type="button" className="refresh-button" onClick={onLoadMore} disabled={loading} style={{ fontSize: "0.75rem", padding: "4px 12px" }}>
            {loading ? "..." : "Load more"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default BacktestCard;
