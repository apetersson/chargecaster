import { useCallback, useEffect, useState } from "react";


import HistoryTable from "./components/HistoryTable";
import MessageList from "./components/MessageList";
import SummaryCards from "./components/SummaryCards";
import TrajectoryTable from "./components/TrajectoryTable";
import { trpcClient } from "./api/trpc";
import { useProjectionChart } from "./hooks/useProjectionChart";
import type { ForecastEra, HistoryPoint, OracleEntry, SnapshotSummary, } from "./types";
import { useIsMobile } from "./hooks/useIsMobile";

const REFRESH_INTERVAL_MS = 60_000;

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (error && typeof error === "object" && "message" in error) {
    const candidate = (error as { message?: unknown }).message;
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return "Unknown error";
};


const App = () => {
  const [summary, setSummary] = useState<SnapshotSummary | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [forecast, setForecast] = useState<ForecastEra[]>([]);
  const [oracleEntries, setOracleEntries] = useState<OracleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const [showPowerAxisLabels, setShowPowerAxisLabels] = useState<boolean>(() => !isMobile);
  const [showPriceAxisLabels, setShowPriceAxisLabels] = useState<boolean>(() => !isMobile);

  useEffect(() => {
    setShowPowerAxisLabels(!isMobile);
    setShowPriceAxisLabels(!isMobile);
  }, [isMobile]);

  const fetchData = useCallback((): void => {
    const execute = async () => {
      try {
        setLoading(true);
        const summaryData = await trpcClient.dashboard.summary.query();
        const historyData = await trpcClient.dashboard.history.query();
        const forecastData = await trpcClient.dashboard.forecast.query();
        const oracleData = await trpcClient.dashboard.oracle.query();

        setSummary(summaryData);

        const entries = Array.isArray(historyData.entries) ? historyData.entries : [];
        setHistory(entries);

        setForecast(Array.isArray(forecastData.eras) ? forecastData.eras : []);
        setOracleEntries(Array.isArray(oracleData.entries) ? oracleData.entries : []);
        setError(null);
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setLoading(false);
      }
    };

    void execute();
  }, []);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => {
      void fetchData();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  const chartRef = useProjectionChart(history, forecast, oracleEntries, summary, {
    isMobile,
    showPowerAxisLabels,
    showPriceAxisLabels,
  });

  return (
    <>
      {error ? (
        <section className="card">
          <p className="status err">{error}</p>
        </section>
      ) : null}

      <SummaryCards data={summary}/>

      <section className="card chart">
        <div style={{display: "flex", justifyContent: "space-between", alignItems: "center"}}>
          <h2>SOC over time</h2>
          {(
            <div className="chart-controls" role="group" aria-label="Chart axis labels">
              <button
                type="button"
                className={`chip ${showPowerAxisLabels ? "active" : ""}`}
                onClick={() => setShowPowerAxisLabels((v) => !v)}
                aria-pressed={showPowerAxisLabels}
              >
                Power
              </button>
              <button
                type="button"
                className={`chip ${showPriceAxisLabels ? "active" : ""}`}
                onClick={() => setShowPriceAxisLabels((v) => !v)}
                aria-pressed={showPriceAxisLabels}
              >
                Tariff
              </button>
            </div>
          )}
        </div>
        <canvas ref={chartRef} aria-label="SOC projection chart"/>
      </section>

      <TrajectoryTable forecast={forecast} oracleEntries={oracleEntries}/>

      <HistoryTable history={history}/>

      <MessageList items={summary?.warnings} tone="warning"/>
      <MessageList items={summary?.errors} tone="error"/>

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
