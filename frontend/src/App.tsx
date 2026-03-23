import { useEffect, useState, type JSX } from "react";

import HistoryTable from "./components/HistoryTable";
import MessageList from "./components/MessageList";
import SummaryCards from "./components/SummaryCards";
import TrajectoryTable from "./components/TrajectoryTable";
import DailyHistoryCard from "./components/DailyHistoryCard";
import { useDashboardData } from "./hooks/useDashboardData";
import { useBacktestHistory } from "./hooks/useBacktestHistory";
import { useProjectionChart } from "./hooks/useProjectionChart/useProjectionChart";
import { useIsMobile } from "./hooks/useIsMobile";

function App(): JSX.Element {
  const {
    summary,
    history,
    forecast,
    demandForecast,
    oracleEntries,
    planningVariant,
    planningVariantDryRunEnabled,
    setPlanningVariant,
    switchingPlanningVariant,
    loading,
    error,
    refresh,
  } = useDashboardData();
  const isMobile = useIsMobile();
  const backtestState = useBacktestHistory();
  const [showPowerAxisLabels, setShowPowerAxisLabels] = useState<boolean>(() => !isMobile);
  const [showPriceAxisLabels, setShowPriceAxisLabels] = useState<boolean>(() => !isMobile);

  useEffect(() => {
    setShowPowerAxisLabels(!isMobile);
    setShowPriceAxisLabels(!isMobile);
  }, [isMobile]);

  const projectionChartRef = useProjectionChart(history, forecast, demandForecast, oracleEntries, summary, {
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
        <div className="section-toolbar">
          <div className="section-title-group">
            <h2>Charge Planning</h2>
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
        {planningVariantDryRunEnabled ? (
          <div className="chart-footer-controls">
            <div className="control-group" role="group" aria-label="Charge planning variant">
              <span className="control-label">Variant</span>
              <div className="chart-controls">
                <button
                  type="button"
                  className={`chip ${planningVariant === "awattar-sunny" ? "active" : ""}`}
                  onClick={() => setPlanningVariant("awattar-sunny")}
                  aria-pressed={planningVariant === "awattar-sunny"}
                  disabled={switchingPlanningVariant}
                >
                  awattar-sunny
                </button>
                <button
                  type="button"
                  className={`chip ${planningVariant === "awattar-sunny-spot" ? "active" : ""}`}
                  onClick={() => setPlanningVariant("awattar-sunny-spot")}
                  aria-pressed={planningVariant === "awattar-sunny-spot"}
                  disabled={switchingPlanningVariant}
                >
                  awattar-sunny-spot
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </section>

      <SummaryCards data={summary} backtestState={backtestState} />

      <DailyHistoryCard backtestState={backtestState} />

      <TrajectoryTable forecast={forecast} demandForecast={demandForecast} oracleEntries={oracleEntries}/>

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
          disabled={loading || switchingPlanningVariant}
        >
          {switchingPlanningVariant ? "Switching variant..." : loading ? "Refreshing..." : "Refresh now"}
        </button>
      </section>
    </>
  );
}

export default App;
