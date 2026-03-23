import { useCallback, useEffect, useState } from "react";

import { trpcClient } from "../api/trpc";
import type {
  DashboardOutputs,
  DemandForecastEntry,
  ForecastEra,
  HistoryPoint,
  OracleEntry,
  PlanningVariant,
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
  key: "ev_charge_power_w" | "site_demand_power_w" | "solar_forecast_power_w",
): number | null {
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type DashboardDataState = {
  summary: DashboardOutputs["summary"] | null;
  history: HistoryPoint[];
  forecast: ForecastEra[];
  demandForecast: DemandForecastEntry[];
  oracleEntries: OracleEntry[];
  planningVariant: PlanningVariant;
  planningVariantDryRunEnabled: boolean;
  setPlanningVariant: (variant: PlanningVariant) => void;
  switchingPlanningVariant: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

export function useDashboardData(): DashboardDataState {
  const [summary, setSummary] = useState<DashboardOutputs["summary"] | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [forecast, setForecast] = useState<ForecastEra[]>([]);
  const [demandForecast, setDemandForecast] = useState<DemandForecastEntry[]>([]);
  const [oracleEntries, setOracleEntries] = useState<OracleEntry[]>([]);
  const [planningVariant, setPlanningVariantState] = useState<PlanningVariant>("awattar-sunny");
  const [planningVariantDryRunEnabled, setPlanningVariantDryRunEnabled] = useState(false);
  const [switchingPlanningVariant, setSwitchingPlanningVariant] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const execute = async () => {
      try {
        setLoading(true);
        const [summaryData, historyData, forecastData, demandForecastData, oracleData, planningVariantData] = await Promise.all([
          trpcClient.dashboard.summary.query(),
          trpcClient.dashboard.history.query(),
          trpcClient.dashboard.forecast.query(),
          trpcClient.dashboard.demandForecast.query(),
          trpcClient.dashboard.oracle.query(),
          trpcClient.dashboard.planningVariant.query(),
        ]);

        setSummary(summaryData);
        setHistory(
          historyData.entries.map((entry) => ({
            ...entry,
            solar_forecast_power_w: readOptionalHistoryNumber(entry, "solar_forecast_power_w"),
            ev_charge_power_w: readOptionalHistoryNumber(entry, "ev_charge_power_w"),
            site_demand_power_w: readOptionalHistoryNumber(entry, "site_demand_power_w"),
          })),
        );
        setForecast(forecastData.eras);
        setDemandForecast(demandForecastData.entries);
        setOracleEntries(oracleData.entries);
        setPlanningVariantState(planningVariantData.variant);
        setPlanningVariantDryRunEnabled(planningVariantData.dryRunEnabled);
        setError(null);
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setLoading(false);
      }
    };

    void execute();
  }, []);

  const setPlanningVariant = useCallback((variant: PlanningVariant) => {
    if (!planningVariantDryRunEnabled) {
      setError("Planning variant switching is only available in dry mode.");
      return;
    }

    const execute = async () => {
      try {
        setSwitchingPlanningVariant(true);
        const result = await trpcClient.dashboard.setPlanningVariant.mutate({variant});
        setPlanningVariantState(result.variant);
        setPlanningVariantDryRunEnabled(result.dryRunEnabled);
        refresh();
      } catch (err) {
        setError(getErrorMessage(err));
      } finally {
        setSwitchingPlanningVariant(false);
      }
    };

    void execute();
  }, [planningVariantDryRunEnabled, refresh]);

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
    demandForecast,
    oracleEntries,
    planningVariant,
    planningVariantDryRunEnabled,
    setPlanningVariant,
    switchingPlanningVariant,
    loading,
    error,
    refresh,
  };
}
