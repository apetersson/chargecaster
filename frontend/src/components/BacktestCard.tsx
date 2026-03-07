import type { JSX } from "react";

import { useBacktestHistory } from "../hooks/useBacktestHistory";
import { formatNumber } from "../utils/format";
import BacktestSummaryGrid from "./backtest/BacktestSummaryGrid";
import DailyHistoryTable from "./backtest/DailyHistoryTable";

function BacktestCard(): JSX.Element | null {
  const {
    backtest,
    backtestLoading,
    backtestError,
    refreshBacktest,
    dailyEntries,
    dailyHasMore,
    dailyLoading,
    dailyLoadingAll,
    dailyError,
    expandedDate,
    detailByDate,
    detailLoadingDate,
    detailErrorByDate,
    refreshDailyHistory,
    loadMoreDailyHistory,
    loadAllDailyHistory,
    toggleDailyDetail,
  } = useBacktestHistory();

  if (backtestError) {
    return (
      <section className="card">
        <h2>Backtest (24h)</h2>
        <p className="status err">{backtestError}</p>
      </section>
    );
  }

  if (!backtest || backtest.history_points_used < 2) {
    return (
      <section className="card">
        <h2>Backtest (24h)</h2>
        <p className="status">{backtestLoading ? "Loading..." : "Not enough history data"}</p>
      </section>
    );
  }

  return (
    <section className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Savings Estimation ({formatNumber(backtest.span_hours, "h")} span)</h2>
        <button
          type="button"
          className="refresh-button"
          onClick={refreshBacktest}
          disabled={backtestLoading}
          style={{ fontSize: "0.75rem", padding: "4px 8px" }}
        >
          {backtestLoading ? "..." : "Refresh"}
        </button>
      </div>

      <BacktestSummaryGrid data={backtest} />

      <DailyHistoryTable
        entries={dailyEntries}
        hasMore={dailyHasMore}
        loading={dailyLoading}
        loadingAll={dailyLoadingAll}
        error={dailyError}
        expandedDate={expandedDate}
        detailByDate={detailByDate}
        detailLoadingDate={detailLoadingDate}
        detailErrorByDate={detailErrorByDate}
        onRefresh={refreshDailyHistory}
        onLoadMore={loadMoreDailyHistory}
        onLoadAll={loadAllDailyHistory}
        onToggleDetail={toggleDailyDetail}
      />
    </section>
  );
}

export default BacktestCard;
