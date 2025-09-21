export interface BatteryConfig {
  capacity_kwh: number;
  max_charge_power_w: number;
  auto_mode_floor_soc?: number;
}

export interface PriceConfig {
  grid_fee_eur_per_kwh?: number;
  network_tariff_eur_per_kwh?: number;
}

export interface LogicConfig {
  interval_seconds?: number;
  min_hold_minutes?: number;
  house_load_w?: number;
}

export interface StateConfig {
  path?: string;
}

export interface SimulationConfig {
  battery: BatteryConfig;
  price: PriceConfig;
  logic: LogicConfig;
  state?: StateConfig;
}

export interface TrajectoryPoint {
  slot_index: number;
  start: string;
  end: string;
  duration_hours: number;
  soc_start_percent: number;
  soc_end_percent: number;
  grid_energy_kwh: number;
  price_eur_per_kwh: number;
}

export interface PriceSlot {
  start: Date;
  end: Date;
  durationHours: number;
  price: number;
}

export interface HistoryPoint {
  timestamp: string;
  battery_soc_percent: number | null;
  price_eur_per_kwh: number | null;
  grid_power_kw: number | null;
  grid_energy_kwh: number | null;
}

export interface SnapshotPayload {
  timestamp: string;
  interval_seconds: number | null;
  house_load_w: number | null;
  current_soc_percent: number | null;
  next_step_soc_percent: number | null;
  recommended_soc_percent: number | null;
  recommended_final_soc_percent: number | null;
  price_snapshot_eur_per_kwh: number | null;
  projected_cost_eur: number | null;
  baseline_cost_eur: number | null;
  projected_savings_eur: number | null;
  projected_grid_energy_kwh: number | null;
  forecast_hours: number | null;
  forecast_samples: number | null;
  trajectory: TrajectoryPoint[];
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
  price_snapshot_eur_per_kwh: number | null;
  projected_cost_eur: number | null;
  baseline_cost_eur: number | null;
  projected_savings_eur: number | null;
  projected_grid_energy_kwh: number | null;
  forecast_hours: number | null;
  forecast_samples: number | null;
  warnings: string[];
  errors: string[];
}

export interface TrajectoryResponse {
  generated_at: string;
  points: TrajectoryPoint[];
}

export interface HistoryResponse {
  generated_at: string;
  entries: HistoryPoint[];
}

export interface SimulationResult {
  snapshot: SnapshotPayload;
  historyEntries: HistoryPoint[];
  rawOutput: Record<string, unknown>;
}
