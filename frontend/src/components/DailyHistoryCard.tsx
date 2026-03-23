import type { JSX } from "react";

import type { UseBacktestHistoryState } from "../hooks/useBacktestHistory";
import SectionCardHeader from "./common/SectionCardHeader";
import DailyHistoryTable from "./backtest/DailyHistoryTable";

type DailyHistoryCardProps = {
  backtestState: UseBacktestHistoryState;
};

function DailyHistoryCard({backtestState}: DailyHistoryCardProps): JSX.Element {
  const {
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
  } = backtestState;

  return (
    <section className="card">
      <SectionCardHeader
        title="Past Daily History"
        subtitle={dailyEntries ? `${dailyEntries.length} historical day${dailyEntries.length === 1 ? "" : "s"}` : "Historical backtest by day"}
        actions={(
          <button
            type="button"
            className="refresh-button"
            onClick={refreshDailyHistory}
            disabled={dailyLoading}
          >
            {dailyLoading ? "Refreshing..." : "Refresh"}
          </button>
        )}
      />

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
        onLoadMore={loadMoreDailyHistory}
        onLoadAll={loadAllDailyHistory}
        onToggleDetail={toggleDailyDetail}
      />
    </section>
  );
}

export default DailyHistoryCard;
