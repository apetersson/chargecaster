import { useCallback, useEffect, useState } from "react";

import { trpcClient } from "../api/trpc";
import type {
  BacktestResult,
  DailyBacktestDetail,
  DailyBacktestEntry,
} from "../types";

const DAILY_PAGE_SIZE = 7;
const DAILY_LOAD_ALL_PAGE_SIZE = 31;

type DailyBacktestDetailsByDate = Partial<Record<string, DailyBacktestDetail>>;
type DailyBacktestErrorsByDate = Partial<Record<string, string>>;

type UseBacktestHistoryState = {
  backtest: BacktestResult | null;
  backtestLoading: boolean;
  backtestError: string | null;
  refreshBacktest: () => void;
  dailyEntries: DailyBacktestEntry[] | null;
  dailyHasMore: boolean;
  dailyLoading: boolean;
  dailyLoadingAll: boolean;
  dailyError: string | null;
  expandedDate: string | null;
  detailByDate: DailyBacktestDetailsByDate;
  detailLoadingDate: string | null;
  detailErrorByDate: DailyBacktestErrorsByDate;
  refreshDailyHistory: () => void;
  loadMoreDailyHistory: () => void;
  loadAllDailyHistory: () => void;
  toggleDailyDetail: (date: string) => void;
};

function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function useBacktestHistory(): UseBacktestHistoryState {
  const [backtest, setBacktest] = useState<BacktestResult | null>(null);
  const [backtestLoading, setBacktestLoading] = useState(true);
  const [backtestError, setBacktestError] = useState<string | null>(null);

  const [dailyEntries, setDailyEntries] = useState<DailyBacktestEntry[] | null>(null);
  const [dailyHasMore, setDailyHasMore] = useState(false);
  const [dailyLoading, setDailyLoading] = useState(true);
  const [dailyLoadingAll, setDailyLoadingAll] = useState(false);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const [detailByDate, setDetailByDate] = useState<DailyBacktestDetailsByDate>({});
  const [detailLoadingDate, setDetailLoadingDate] = useState<string | null>(null);
  const [detailErrorByDate, setDetailErrorByDate] = useState<DailyBacktestErrorsByDate>({});

  const refreshBacktest = useCallback(() => {
    const run = async () => {
      try {
        setBacktestLoading(true);
        setBacktestError(null);
        const result = await trpcClient.dashboard.backtest.query();
        setBacktest(result);
      } catch (error) {
        setBacktestError(getErrorMessage(error, "Failed to load backtest"));
      } finally {
        setBacktestLoading(false);
      }
    };

    void run();
  }, []);

  const loadDailyPage = useCallback((skip: number, limit = DAILY_PAGE_SIZE) => {
    const run = async () => {
      try {
        setDailyLoading(true);
        setDailyError(null);
        const page = await trpcClient.dashboard.backtestHistory.query({ limit, skip });
        setDailyEntries((previous) =>
          skip === 0 ? page.entries : [...(previous ?? []), ...page.entries],
        );
        if (skip === 0) {
          setExpandedDate(null);
        }
        setDailyHasMore(page.hasMore);
      } catch (error) {
        setDailyError(getErrorMessage(error, "Failed to load daily history"));
      } finally {
        setDailyLoading(false);
      }
    };

    void run();
  }, []);

  const refreshDailyHistory = useCallback(() => {
    loadDailyPage(0);
  }, [loadDailyPage]);

  const loadMoreDailyHistory = useCallback(() => {
    loadDailyPage(dailyEntries?.length ?? 0);
  }, [dailyEntries, loadDailyPage]);

  const loadAllDailyHistory = useCallback(() => {
    const run = async () => {
      try {
        setDailyLoadingAll(true);
        setDailyLoading(true);
        setDailyError(null);

        const aggregated: DailyBacktestEntry[] = [];
        let skip = 0;
        let hasMore = true;

        while (hasMore) {
          const page = await trpcClient.dashboard.backtestHistory.query({
            limit: DAILY_LOAD_ALL_PAGE_SIZE,
            skip,
          });
          aggregated.push(...page.entries);
          hasMore = page.hasMore;
          skip = aggregated.length;
        }

        setDailyEntries(aggregated);
        setDailyHasMore(false);
        setExpandedDate(null);
      } catch (error) {
        setDailyError(getErrorMessage(error, "Failed to load daily history"));
      } finally {
        setDailyLoading(false);
        setDailyLoadingAll(false);
      }
    };

    void run();
  }, []);

  const toggleDailyDetail = useCallback(
    (date: string) => {
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
          setDetailErrorByDate((previous) => {
            const next = { ...previous };
            delete next[date];
            return next;
          });
          const detail = await trpcClient.dashboard.backtestHistoryDetail.query({ date });
          if (detail) {
            setDetailByDate((previous) => ({ ...previous, [date]: detail }));
          }
        } catch (error) {
          setDetailErrorByDate((previous) => ({
            ...previous,
            [date]: getErrorMessage(error, "Failed to load daily backtest detail"),
          }));
        } finally {
          setDetailLoadingDate((current) => (current === date ? null : current));
        }
      };

      void run();
    },
    [detailByDate, detailLoadingDate, expandedDate],
  );

  useEffect(() => {
    refreshBacktest();
  }, [refreshBacktest]);

  useEffect(() => {
    refreshDailyHistory();
  }, [refreshDailyHistory]);

  return {
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
  };
}
