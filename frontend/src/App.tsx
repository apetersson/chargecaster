import { useEffect, useState, type JSX } from "react";

import HistoryTable from "./components/HistoryTable";
import MessageList from "./components/MessageList";
import SummaryCards from "./components/SummaryCards";
import TrajectoryTable from "./components/TrajectoryTable";
import BacktestCard from "./components/BacktestCard";
import { useDashboardData } from "./hooks/useDashboardData";
import { useProjectionChart } from "./hooks/useProjectionChart/useProjectionChart";
import { useIsMobile } from "./hooks/useIsMobile";

function App(): JSX.Element {
  const { summary, history, forecast, oracleEntries, loading, error, refresh } = useDashboardData();
  const isMobile = useIsMobile();
  const [showPowerAxisLabels, setShowPowerAxisLabels] = useState<boolean>(() => !isMobile);
  const [showPriceAxisLabels, setShowPriceAxisLabels] = useState<boolean>(() => !isMobile);

  useEffect(() => {
    setShowPowerAxisLabels(!isMobile);
    setShowPriceAxisLabels(!isMobile);
  }, [isMobile]);

  const projectionChartRef = useProjectionChart(history, forecast, oracleEntries, summary, {
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

      <section className="card chart">
        <div style={{display: "flex", justifyContent: "space-between", alignItems: "center"}}>
          <div style={{display: "flex", alignItems: "center", gap: 8}}>
            <h2 style={{marginRight: 8}}>Charge Planning</h2>
          </div>
          <div className="chart-controls" role="group" aria-label="Chart display">
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
          <canvas ref={projectionChartRef} aria-label="SOC projection chart"/>
        </div>
      </section>

      <SummaryCards data={summary}/>

      <BacktestCard />

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
            refresh();
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
