import { useCallback, useEffect, useState } from "react";

import HistoryTable from "./components/HistoryTable";
import MessageList from "./components/MessageList";
import SummaryCards from "./components/SummaryCards";
import TrajectoryTable from "./components/TrajectoryTable";
import { trpcClient } from "./api/trpc";
import { useProjectionChart } from "./hooks/useProjectionChart";
import type {
  ForecastEra,
  HistoryPoint,
  OracleEntry,
  SnapshotSummary,
} from "./types";

const REFRESH_INTERVAL_MS = 60_000;

const toNumber = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.length > 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }
  return null;
};

const toTimestamp = (value: unknown): string => {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
};

const normalizeHistoryEntry = (entry: unknown): HistoryPoint => {
  const record = (entry ?? {}) as Record<string, unknown>;
  const priceCt = toNumber(record.price_ct_per_kwh);
  const priceEur = toNumber(record.price_eur_per_kwh);
  return {
    timestamp: toTimestamp(record.timestamp),
    battery_soc_percent: toNumber(record.battery_soc_percent),
    price_ct_per_kwh: priceCt ?? (priceEur !== null ? priceEur * 100 : null),
    price_eur_per_kwh: priceEur,
    grid_power_w: null,
    grid_energy_w: null,
  };
};


const App = () => {
  const [summary, setSummary] = useState<SnapshotSummary | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [forecast, setForecast] = useState<ForecastEra[]>([]);
  const [oracleEntries, setOracleEntries] = useState<OracleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const [summaryData, historyData, forecastData, oracleData] = await Promise.all([
        trpcClient.dashboard.summary.query(),
        trpcClient.dashboard.history.query(),
        trpcClient.dashboard.forecast.query(),
        trpcClient.dashboard.oracle.query(),
      ]);

      setSummary(summaryData);

      const normalizedHistory = (historyData.entries ?? []).map((entry) =>
        normalizeHistoryEntry(entry),
      );
      setHistory(normalizedHistory);

      setForecast(Array.isArray(forecastData.eras) ? forecastData.eras : []);
      setOracleEntries(Array.isArray(oracleData.entries) ? oracleData.entries : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => {
      void fetchData();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  const chartRef = useProjectionChart(history, forecast, oracleEntries, summary);

  return (
    <>
      {error ? (
        <section className="card">
          <p className="status err">{error}</p>
        </section>
      ) : null}

      <SummaryCards data={summary} />

      <section className="card chart">
        <h2>SOC over time</h2>
        <canvas ref={chartRef} aria-label="SOC projection chart" />
      </section>

      <TrajectoryTable forecast={forecast} oracleEntries={oracleEntries} />

      <HistoryTable history={history} />

      <MessageList items={summary?.warnings} tone="warning" />
      <MessageList items={summary?.errors} tone="error" />

      <section className="card banner">
        <div>
          <h2>Latest Optimisation</h2>
          <p>Live data reloads every minute from batteryctl.</p>
        </div>
        <button
          type="button"
          className="refresh-button"
          onClick={() => {
            void fetchData();
          }}
          disabled={loading}
        >
          {loading ? "Refreshing..." : "Refresh now"}
        </button>
      </section>
    </>
  );
};

export default App;
