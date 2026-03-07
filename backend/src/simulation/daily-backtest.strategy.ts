import type { BacktestResultSummary, SimulationConfig, SnapshotPayload } from "@chargecaster/domain";

export interface BacktestInterval {
  timestamp: string;
  duration_hours: number;
  price_eur_per_kwh: number;
  home_power_w: number;
  site_demand_power_w: number;
  synthetic_hidden_load_w: number;
  solar_power_w: number;
  actual_grid_power_w: number;
  actual_soc_percent: number;
  simulated_soc_percent: number;
  simulated_grid_power_w: number;
  actual_cost_eur: number;
  simulated_cost_eur: number;
}

export interface BacktestResult extends BacktestResultSummary {
  intervals: BacktestInterval[];
}

export interface DailyBacktestEntry {
  date: string;
  result: BacktestResult;
}

export interface DailyHistoryIndex {
  today: string;
  yesterday: string;
  availableDays: string[];
  completeDays: Set<string>;
}

export interface BuildDailyBacktestOptions {
  snapshot?: SnapshotPayload;
  fallbackMarginalPrice?: number;
}

export interface DailyBacktestStrategy {
  readonly name: string;
  run(snapshot: SnapshotPayload, config: SimulationConfig): BacktestResult;
  buildDailyEntry(date: string, config: SimulationConfig, options?: BuildDailyBacktestOptions): DailyBacktestEntry | null;
}

export const DAILY_BACKTEST_STRATEGY = Symbol("DAILY_BACKTEST_STRATEGY");
