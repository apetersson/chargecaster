export type TrajectoryPoint = {
  slot_index: number;
  start: string | null;
  end: string | null;
  duration_hours: number;
  soc_start_percent: number;
  soc_end_percent: number;
  grid_energy_kwh: number;
  price_eur_per_kwh: number;
};

export type HistoryPoint = {
  timestamp: string;
  battery_soc_percent?: number;
  price_eur_per_kwh?: number;
  grid_power_kw?: number;
  grid_energy_kwh?: number;
};

export type SnapshotPayload = {
  timestamp: string | null;
  interval_seconds: number | null;
  house_load_w: number | null;
  current_soc_percent: number | null;
  next_step_soc_percent: number | null;
  recommended_soc_percent: number | null;
  recommended_final_soc_percent: number | null;
  price_snapshot_eur_per_kwh: string | number | null;
  projected_cost_eur: number | null;
  projected_grid_energy_kwh: number | null;
  forecast_hours: number | null;
  forecast_samples: number | null;
  trajectory: TrajectoryPoint[];
  history?: HistoryPoint[];
  warnings?: string[];
  errors?: string[];
};
