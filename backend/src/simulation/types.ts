export interface BatteryConfig {
  capacity_kwh: number;
  max_charge_power_w: number;
  auto_mode_floor_soc?: number;
}

export interface PriceConfig {
  grid_fee_eur_per_kwh?: number;
  network_tariff_eur_per_kwh?: number;
  feed_in_tariff_eur_per_kwh?: number;
}

export interface LogicConfig {
  interval_seconds?: number;
  min_hold_minutes?: number;
  house_load_w?: number;
}

export interface SolarConfig {
  direct_use_ratio?: number;
  max_charge_power_w?: number;
}

export interface StateConfig {
  path?: string;
}

export interface SimulationConfig {
  battery: BatteryConfig;
  price: PriceConfig;
  logic: LogicConfig;
  solar?: SolarConfig;
  state?: StateConfig;
}

export interface PriceSlot {
  start: Date;
  end: Date;
  durationHours: number;
  price: number;
  eraId?: string;
}

export interface HistoryPoint {
  timestamp: string;
  battery_soc_percent: number | null;
  price_ct_per_kwh?: number | null;
  price_eur_per_kwh: number | null; // deprecated
  grid_power_w: number | null;
  grid_energy_w: number | null;
  solar_power_w: number | null;
  solar_energy_wh: number | null;
}

export type ForecastSourceType = "cost" | "solar" | (string & {});

export interface ForecastSourcePayload {
  provider: string;
  type: ForecastSourceType;
  payload: Record<string, unknown>;
}

export interface ForecastEra {
  era_id: string;
  start: string | null;
  end: string | null;
  duration_hours: number | null;
  sources: ForecastSourcePayload[];
}

export interface SnapshotPayload {
  timestamp: string;
  interval_seconds: number | null;
  house_load_w: number | null;
  current_soc_percent: number | null;
  next_step_soc_percent: number | null;
  recommended_soc_percent: number | null;
  recommended_final_soc_percent: number | null;
  price_snapshot_ct_per_kwh?: number | null;
  price_snapshot_eur_per_kwh: number | null; // deprecated
  projected_cost_eur: number | null;
  baseline_cost_eur: number | null;
  projected_savings_eur: number | null;
  projected_grid_energy_w: number | null;
  forecast_hours: number | null;
  forecast_samples: number | null;
  forecast_eras: ForecastEra[];
  oracle_entries: OracleEntry[];
  history: HistoryPoint[];
  warnings: string[];
  errors: string[];
}

export interface SnapshotSummary {
  timestamp: string;
  interval_seconds: number | null;
  house_load_w: number | null;
  current_soc_percent: number | null;
  next_step_soc_percent: number | null;
  recommended_soc_percent: number | null;
  recommended_final_soc_percent: number | null;
  price_snapshot_ct_per_kwh?: number | null;
  price_snapshot_eur_per_kwh: number | null;
  projected_cost_eur: number | null;
  baseline_cost_eur: number | null;
  projected_savings_eur: number | null;
  projected_grid_energy_w: number | null;
  forecast_hours: number | null;
  forecast_samples: number | null;
  warnings: string[];
  errors: string[];
}

export interface HistoryResponse {
  generated_at: string;
  entries: HistoryPoint[];
}

export interface ForecastResponse {
  generated_at: string;
  eras: ForecastEra[];
}

export interface OracleEntry {
  era_id: string;
  start_soc_percent: number | null;
  end_soc_percent: number | null;
  /**
   * @deprecated use end_soc_percent instead
   */
  target_soc_percent?: number | null;
  grid_power_w: number | null;
  grid_energy_kwh: number | null;
  /**
   * @deprecated use grid_power_w/grid_energy_kwh instead
   */
  grid_energy_w?: number | null;
  strategy: "charge" | "auto";
}

export interface OracleResponse {
  generated_at: string;
  entries: OracleEntry[];
}

export interface ForecastSlotInput {
  start: string;
  end: string | null;
  price: number | null;
  unit: string | null;
  price_ct_per_kwh: number | null;
  duration_hours: number | null;
  era_id?: string;
}

export interface SolarSlotInput {
  start: string;
  end: string | null;
  energy_kwh: number | null;
}

