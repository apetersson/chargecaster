import { useEffect, useMemo, useState, type JSX } from "react";

import HistoryTable from "./components/HistoryTable";
import MessageList from "./components/MessageList";
import SummaryCards from "./components/SummaryCards";
import TrajectoryTable from "./components/TrajectoryTable";
import DailyHistoryCard from "./components/DailyHistoryCard";
import { useDashboardData } from "./hooks/useDashboardData";
import { useBacktestHistory } from "./hooks/useBacktestHistory";
import { useProjectionChart } from "./hooks/useProjectionChart/useProjectionChart";
import { useIsMobile } from "./hooks/useIsMobile";

const PREVIEW_HOURS_OPTIONS = [24, 48, 72, 96, 120] as const;

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
  const [previewHours, setPreviewHours] = useState<number>(24);

  useEffect(() => {
    setShowPowerAxisLabels(!isMobile);
    setShowPriceAxisLabels(!isMobile);
  }, [isMobile]);

  const {filteredForecast, filteredDemandForecast} = useMemo(() => {
    const nowMs = Date.now();
    const cutoffMs = nowMs + (previewHours * 3_600_000);
    const visibleForecast = forecast.filter((era) => {
      const startMs = era.start ? new Date(era.start).getTime() : Number.NaN;
      return Number.isFinite(startMs) && startMs < cutoffMs;
    });
    const visibleDemand = demandForecast.filter((entry) => {
      const startMs = new Date(entry.start).getTime();
      return Number.isFinite(startMs) && startMs < cutoffMs;
    });
    return {
      filteredForecast: visibleForecast,
      filteredDemandForecast: visibleDemand,
    };
  }, [demandForecast, forecast, previewHours]);

  const projectionChartRef = useProjectionChart(history, filteredForecast, filteredDemandForecast, oracleEntries, summary, {
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
        <div className="chart-footer-controls">
          <div className="control-group" aria-label="Forecast preview horizon">
            <span className="control-label">Preview</span>
            <select
              className="control-select"
              value={previewHours}
              onChange={(event) => setPreviewHours(Number(event.target.value))}
            >
              {PREVIEW_HOURS_OPTIONS.map((hours) => (
                <option key={hours} value={hours}>{hours}h</option>
              ))}
            </select>
          </div>
          {planningVariantDryRunEnabled ? (
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
          ) : null}
        </div>
      </section>

      <SummaryCards data={summary} backtestState={backtestState} />

      <DailyHistoryCard backtestState={backtestState} />

      <TrajectoryTable forecast={filteredForecast} demandForecast={filteredDemandForecast} oracleEntries={oracleEntries}/>

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
