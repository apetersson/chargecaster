import type { BacktestResultSummary, SimulationConfig, SnapshotPayload } from "@chargecaster/domain";
import { EnergyPrice, Money, Percentage, Power, TimeSlot } from "@chargecaster/domain";
import type { ConfigDocument } from "../config/schemas";

export interface BacktestInterval {
  slot: TimeSlot;
  price: EnergyPrice;
  homePower: Power;
  siteDemandPower: Power;
  syntheticHiddenLoad: Power;
  solarPower: Power;
  actualGridPower: Power;
  actualSoc: Percentage;
  simulatedSocStart: Percentage;
  simulatedSoc: Percentage;
  simulatedGridPower: Power;
  actualCost: Money;
  simulatedCost: Money;
  cashSavings: Money;
  cumulativeCashSavings: Money;
  inventoryValue: Money;
  cumulativeSavings: Money;
  actualChargeFromSolar: Power;
  actualChargeFromGrid: Power;
  simulatedChargeFromSolar: Power;
}

export interface BacktestIntervalPayload {
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

export interface BacktestResult extends BacktestResultSummary {
  intervals: BacktestIntervalPayload[];
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
  configDocument?: ConfigDocument;
  snapshot?: SnapshotPayload;
  fallbackMarginalPrice?: number;
  initialSimSocPercent?: number | null;
}

export interface DailyBacktestStrategy {
  readonly name: string;
  readonly requiresSequentialState: boolean;
  run(snapshot: SnapshotPayload, config: SimulationConfig, options?: BuildDailyBacktestOptions): BacktestResult;
  buildDailyEntry(date: string, config: SimulationConfig, options?: BuildDailyBacktestOptions): DailyBacktestEntry | null;
}

export const DAILY_BACKTEST_STRATEGY = Symbol("DAILY_BACKTEST_STRATEGY");
