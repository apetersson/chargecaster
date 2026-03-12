import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@backend/trpc";

export type {
  DemandForecastEntry,
  DemandForecastResponse,
  HistoryPoint,
  HistoryResponse,
  ForecastEra,
  ForecastResponse,
  ForecastSourcePayload,
  OracleEntry,
  OracleResponse,
  SnapshotSummary,
} from "@chargecaster/domain";

export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type DashboardOutputs = RouterOutputs["dashboard"];

export interface BacktestInterval {
  timestamp: string;
  end_timestamp: string;
  duration_hours: number;
  price_eur_per_kwh: number;
  home_power_w: number;
  site_demand_power_w: number;
  synthetic_hidden_load_w: number;
  solar_power_w: number;
  actual_grid_power_w: number;
  actual_soc_percent: number;
  simulated_soc_start_percent: number;
  simulated_soc_percent: number;
  simulated_grid_power_w: number;
  actual_cost_eur: number;
  simulated_cost_eur: number;
  cash_savings_eur: number;
  cumulative_cash_savings_eur: number;
  inventory_value_eur: number;
  cumulative_savings_eur: number;
  actual_charge_from_solar_w: number;
  actual_charge_from_grid_w: number;
  simulated_charge_from_solar_w: number;
}

export interface BacktestResult {
  generated_at: string;
  actual_total_cost_eur: number;
  simulated_total_cost_eur: number;
  simulated_start_soc_percent: number;
  actual_final_soc_percent: number;
  simulated_final_soc_percent: number;
  soc_value_adjustment_eur: number;
  adjusted_actual_cost_eur: number;
  adjusted_simulated_cost_eur: number;
  savings_eur: number;
  avg_price_eur_per_kwh: number;
  history_points_used: number;
  span_hours: number;
  intervals: BacktestInterval[];
}

export interface DailyBacktestEntry {
  date: string;
  result: BacktestResult;
}

export interface DailyBacktestPage {
  entries: DailyBacktestEntry[];
  hasMore: boolean;
}

export type DailyBacktestDetail = DailyBacktestEntry;
