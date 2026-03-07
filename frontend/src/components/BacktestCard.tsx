import { Fragment, useCallback, useEffect, useState, type JSX } from "react";

import { trpcClient } from "../api/trpc";
import { formatNumber } from "../utils/format";
import DailyBacktestDetailChart from "./DailyBacktestDetailChart";

interface BacktestInterval {
  timestamp: string;
  end_timestamp: string;
  duration_hours: number;
  price_eur_per_kwh: number;
  home_power_w: number;
  site_demand_power_w: number;
  synthetic_hidden_load_w: number;
  solar_power_w: number;
  actual_grid_power_w: number;
  actual_soc_percent: number;
  simulated_soc_start_percent: number;
  simulated_soc_percent: number;
  simulated_grid_power_w: number;
  actual_cost_eur: number;
  simulated_cost_eur: number;
  cash_savings_eur: number;
  cumulative_cash_savings_eur: number;
  inventory_value_eur: number;
  cumulative_savings_eur: number;
  actual_charge_from_solar_w: number;
  actual_charge_from_grid_w: number;
  simulated_charge_from_solar_w: number;
}

interface BacktestResult {
  generated_at: string;
  actual_total_cost_eur: number;
  simulated_total_cost_eur: number;
  simulated_start_soc_percent: number;
  actual_final_soc_percent: number;
  simulated_final_soc_percent: number;
  soc_value_adjustment_eur: number;
  adjusted_actual_cost_eur: number;
  adjusted_simulated_cost_eur: number;
  savings_eur: number;
  avg_price_eur_per_kwh: number;
  history_points_used: number;
  span_hours: number;
  intervals: BacktestInterval[];
}

interface DailyBacktestEntry {
  date: string;
  result: BacktestResult;
}

interface DailyBacktestPage {
  entries: DailyBacktestEntry[];
  hasMore: boolean;
}

type DailyBacktestDetail = DailyBacktestEntry;

const dashboard = trpcClient.dashboard as Record<string, unknown> as {
  backtest: { query: () => Promise<BacktestResult> };
  backtestHistory: { query: (input: { limit: number; skip: number }) => Promise<DailyBacktestPage> };
  backtestHistoryDetail: { query: (input: { date: string }) => Promise<DailyBacktestDetail> };
};

function formatSignedNumber(value: number, unit = ""): string {
  const sign = value >= 0 ? "+" : "-";
  return `${sign}${formatNumber(Math.abs(value), unit)}`;
}

function BacktestCard(): JSX.Element | null {
  const [data, setData] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [dailyEntries, setDailyEntries] = useState<DailyBacktestEntry[] | null>(null);
  const [dailyHasMore, setDailyHasMore] = useState(false);
  const [dailyLoading, setDailyLoading] = useState(false);
  const [dailyLoadingAll, setDailyLoadingAll] = useState(false);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [detailByDate, setDetailByDate] = useState<Partial<Record<string, DailyBacktestDetail>>>({});
  const [detailLoadingDate, setDetailLoadingDate] = useState<string | null>(null);
  const [detailErrorByDate, setDetailErrorByDate] = useState<Partial<Record<string, string>>>({});

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
        if (skip === 0) {
          setExpandedDate(null);
        }
        setDailyHasMore(page.hasMore);
      } catch (err) {
        setDailyError(err instanceof Error ? err.message : "Failed to load daily history");
      } finally {
        setDailyLoading(false);
      }
    };
    void run();
  }, []);

  const loadAllDailyPages = useCallback(() => {
    const run = async () => {
      try {
        setDailyLoadingAll(true);
        setDailyLoading(true);
        setDailyError(null);

        const aggregated: DailyBacktestEntry[] = [];
        let skip = 0;
        let hasMore = true;

        while (hasMore) {
          const page = await dashboard.backtestHistory.query({ limit: 31, skip });
          aggregated.push(...page.entries);
          hasMore = page.hasMore;
          skip = aggregated.length;
        }

        setDailyEntries(aggregated);
        setDailyHasMore(false);
        setExpandedDate(null);
      } catch (err) {
        setDailyError(err instanceof Error ? err.message : "Failed to load daily history");
      } finally {
        setDailyLoading(false);
        setDailyLoadingAll(false);
      }
    };
    void run();
  }, []);

  const toggleDailyDetail = useCallback((date: string) => {
    if (expandedDate === date) {
      setExpandedDate(null);
      return;
    }

    setExpandedDate(date);
    if (detailByDate[date] || detailLoadingDate === date) {
      return;
    }

    const run = async () => {
      try {
        setDetailLoadingDate(date);
        setDetailErrorByDate((prev) => {
          const next = { ...prev };
          delete next[date];
          return next;
        });
        const detail = await dashboard.backtestHistoryDetail.query({ date });
        setDetailByDate((prev) => ({ ...prev, [date]: detail }));
      } catch (err) {
        setDetailErrorByDate((prev) => ({
          ...prev,
          [date]: err instanceof Error ? err.message : "Failed to load daily backtest detail",
        }));
      } finally {
        setDetailLoadingDate((current) => (current === date ? null : current));
      }
    };
    void run();
  }, [detailByDate, detailLoadingDate, expandedDate]);

  useEffect(() => {
    void fetchBacktest();
  }, [fetchBacktest]);

  useEffect(() => {
    loadDailyPage(0);
  }, [loadDailyPage]);

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
        <h2>Savings Estimation ({formatNumber(data.span_hours, "h")} span)</h2>
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
          <span
            className={`value small ${savingsPositive ? "positive" : "negative"}`}
          >
            {formatSignedNumber(data.savings_eur, " EUR")}
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
        loadingAll={dailyLoadingAll}
        error={dailyError}
        expandedDate={expandedDate}
        detailByDate={detailByDate}
        detailLoadingDate={detailLoadingDate}
        detailErrorByDate={detailErrorByDate}
        onLoad={() => { loadDailyPage(0); }}
        onLoadMore={() => { loadDailyPage(dailyEntries?.length ?? 0); }}
        onLoadAll={loadAllDailyPages}
        onToggleDetail={toggleDailyDetail}
      />
    </section>
  );
}

interface DailyHistorySectionProps {
  entries: DailyBacktestEntry[] | null;
  hasMore: boolean;
  loading: boolean;
  loadingAll: boolean;
  error: string | null;
  expandedDate: string | null;
  detailByDate: Partial<Record<string, DailyBacktestDetail>>;
  detailLoadingDate: string | null;
  detailErrorByDate: Partial<Record<string, string>>;
  onLoad: () => void;
  onLoadMore: () => void;
  onLoadAll: () => void;
  onToggleDetail: (date: string) => void;
}

function DailyHistorySection({
  entries,
  hasMore,
  loading,
  loadingAll,
  error,
  expandedDate,
  detailByDate,
  detailLoadingDate,
  detailErrorByDate,
  onLoad,
  onLoadMore,
  onLoadAll,
  onToggleDetail,
}: DailyHistorySectionProps): JSX.Element {
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
              const expanded = expandedDate === date;
              const detail = detailByDate[date];
              const detailError = detailErrorByDate[date];
              const detailLoading = detailLoadingDate === date;
              return (
                <Fragment key={date}>
                  <tr
                    className={`backtest-history-row ${expanded ? "expanded" : ""}`}
                    style={{ borderBottom: "1px solid var(--border-subtle, #222)" }}
                    onClick={() => { onToggleDetail(date); }}
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
                    <td style={{ padding: "4px 6px", textAlign: "right", color: pos ? "var(--positive, #4caf50)" : "var(--negative, #f44336)" }}>
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
              <td style={{ padding: "4px 6px", textAlign: "right", color: totalSavings > 0 ? "var(--positive, #4caf50)" : "var(--negative, #f44336)" }}>
                {formatSignedNumber(totalSavings, " EUR")}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
      {hasMore ? (
        <div style={{ marginTop: "0.5rem", textAlign: "center", display: "flex", justifyContent: "center", gap: "0.6rem", flexWrap: "wrap" }}>
          <button type="button" className="refresh-button" onClick={onLoadMore} disabled={loading} style={{ fontSize: "0.75rem", padding: "4px 12px" }}>
            {loading && !loadingAll ? "..." : "Load more"}
          </button>
          <button type="button" className="refresh-button" onClick={onLoadAll} disabled={loading} style={{ fontSize: "0.75rem", padding: "4px 12px" }}>
            {loadingAll ? "..." : "Load all"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default BacktestCard;
