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

function BacktestCard(): JSX.Element | null {
  const [data, setData] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBacktest = useCallback(() => {
    const run = async () => {
      try {
        setLoading(true);
        setError(null);
        const result = await (trpcClient.dashboard as Record<string, unknown> as {
          backtest: { query: () => Promise<BacktestResult> };
        }).backtest.query();
        setData(result);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load backtest");
      } finally {
        setLoading(false);
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
    </section>
  );
}

export default BacktestCard;
