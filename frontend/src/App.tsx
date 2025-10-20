import { useCallback, useEffect, useState, type JSX } from "react";

import HistoryTable from "./components/HistoryTable";
import MessageList from "./components/MessageList";
import SummaryCards from "./components/SummaryCards";
import TrajectoryTable from "./components/TrajectoryTable";
import { trpcClient } from "./api/trpc";
import { useProjectionChart } from "./hooks/useProjectionChart/useProjectionChart";
import { useBacktestChart } from "./hooks/useBacktestChart/useBacktestChart";
import type {
  ForecastEra,
  HistoryPoint,
  OracleEntry,
  BacktestSeriesResponse,
  DashboardOutputs,
} from "./types";
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


function App(): JSX.Element {
  const [summary, setSummary] = useState<DashboardOutputs["summary"] | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [forecast, setForecast] = useState<ForecastEra[]>([]);
  const [oracleEntries, setOracleEntries] = useState<OracleEntry[]>([]);
  const [backtest, setBacktest] = useState<BacktestSeriesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const [showPowerAxisLabels, setShowPowerAxisLabels] = useState<boolean>(() => !isMobile);
  const [showPriceAxisLabels, setShowPriceAxisLabels] = useState<boolean>(() => !isMobile);
  const [chartMode, setChartMode] = useState<"projection" | "backtest">("projection");
  const [focusMode, setFocusMode] = useState<"smart" | "dumb">("dumb");

  useEffect(() => {
    setShowPowerAxisLabels(!isMobile);
    setShowPriceAxisLabels(!isMobile);
  }, [isMobile]);

  const fetchBacktest = useCallback(async (): Promise<void> => {
    try {
      const data = await trpcClient.dashboard.backtest24h.query();
      setBacktest(data);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, []);

  const fetchData = useCallback((): void => {
    const execute = async () => {
      try {
        setLoading(true);
        const [
          summaryData,
          historyData,
          forecastData,
          oracleData,
          backtestData,
        ] = await Promise.all([
          trpcClient.dashboard.summary.query(),
          trpcClient.dashboard.history.query(),
          trpcClient.dashboard.forecast.query(),
          trpcClient.dashboard.oracle.query(),
          trpcClient.dashboard.backtest24h.query(),
        ]);

        setSummary(summaryData);
        setHistory(historyData.entries);
        setForecast(forecastData.eras);
        setOracleEntries(oracleData.entries);
        setBacktest(backtestData);
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

  const projectionChartRef = useProjectionChart(history, forecast, oracleEntries, summary, {
    isMobile,
    showPowerAxisLabels,
    showPriceAxisLabels,
  });
  const backtestChartRef = useBacktestChart(backtest, {
    isMobile,
    showPowerAxisLabels,
    showPriceAxisLabels,
    focus: focusMode,
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
          <div style={{display: "flex", alignItems: "center", gap: 8}}>
            <h2 style={{marginRight: 8}}>{chartMode === "projection" ? "SOC over time" : "Backtest (Past 24h)"}</h2>
            {chartMode === "backtest" ? (
              <div className="chart-controls" role="group" aria-label="Series focus">
                <button
                  type="button"
                  className={`chip ${focusMode === "smart" ? "active" : ""}`}
                  onClick={() => setFocusMode("smart")}
                  aria-pressed={focusMode === "smart"}
                  title="Highlight smart data"
                >
                  Smart
                </button>
                <button
                  type="button"
                  className={`chip ${focusMode === "dumb" ? "active" : ""}`}
                  onClick={() => setFocusMode("dumb")}
                  aria-pressed={focusMode === "dumb"}
                  title="Highlight dumb baseline"
                >
                  Dumb
                </button>
              </div>
            ) : null}
          </div>
          <div className="chart-controls" role="group" aria-label="Chart display">
            <button
              type="button"
              className={`chip ${chartMode === "backtest" ? "active" : ""}`}
              onClick={() => {
                setChartMode("backtest");
                void fetchBacktest();
              }}
              aria-pressed={chartMode === "backtest"}
            >
              Backtest
            </button>
            <button
              type="button"
              className={`chip ${chartMode === "projection" ? "active" : ""}`}
              onClick={() => setChartMode("projection")}
              aria-pressed={chartMode === "projection"}
            >
              Projection
            </button>
            <span style={{marginLeft: 12}}/>
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
              Values
            </button>
          </div>
        </div>
        <div className="chart-viewport">
          {chartMode === "projection" ? (
            <canvas ref={projectionChartRef} aria-label="SOC projection chart"/>
          ) : (
            <canvas ref={backtestChartRef} aria-label="Backtest 24h chart"/>
          )}
        </div>
      </section>

      <TrajectoryTable forecast={forecast} oracleEntries={oracleEntries} summary={summary}/>

      <HistoryTable history={history}/>

      <MessageList items={summary?.warnings} tone="warning"/>
      <MessageList items={summary?.errors} tone="error"/>

      <section className="card banner">
        <div>
          <h2>Latest Optimisation</h2>
          <p>Live data reloads every minute from chargecaster.</p>
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
}

export default App;
