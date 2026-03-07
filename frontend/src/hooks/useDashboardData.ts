import { useCallback, useEffect, useState } from "react";

import { trpcClient } from "../api/trpc";
import type {
  DashboardOutputs,
  ForecastEra,
  HistoryPoint,
  OracleEntry,
} from "../types";

const REFRESH_INTERVAL_MS = 60_000;

function getErrorMessage(error: unknown): string {
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
}

function readOptionalHistoryNumber(
  entry: object,
  key: "ev_charge_power_w" | "site_demand_power_w",
): number | null {
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type DashboardDataState = {
  summary: DashboardOutputs["summary"] | null;
  history: HistoryPoint[];
  forecast: ForecastEra[];
  oracleEntries: OracleEntry[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

export function useDashboardData(): DashboardDataState {
  const [summary, setSummary] = useState<DashboardOutputs["summary"] | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [forecast, setForecast] = useState<ForecastEra[]>([]);
  const [oracleEntries, setOracleEntries] = useState<OracleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const execute = async () => {
      try {
        setLoading(true);
        const [summaryData, historyData, forecastData, oracleData] = await Promise.all([
          trpcClient.dashboard.summary.query(),
          trpcClient.dashboard.history.query(),
          trpcClient.dashboard.forecast.query(),
          trpcClient.dashboard.oracle.query(),
        ]);

        setSummary(summaryData);
        setHistory(
          historyData.entries.map((entry) => ({
            ...entry,
            ev_charge_power_w: readOptionalHistoryNumber(entry, "ev_charge_power_w"),
            site_demand_power_w: readOptionalHistoryNumber(entry, "site_demand_power_w"),
          })),
        );
        setForecast(forecastData.eras);
        setOracleEntries(oracleData.entries);
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
    refresh();
    const interval = setInterval(() => {
      refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  return {
    summary,
    history,
    forecast,
    oracleEntries,
    loading,
    error,
    refresh,
  };
}
