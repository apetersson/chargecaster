import { z } from "zod";

import {
  nullableNumberSchema,
  optionalBooleanSchema,
  optionalStringSchema,
  optionalTimestampSchema,
  requiredTimestampSchema,
} from "./parsing";
import { TariffSlot } from "./tariff-slot";

export const rawForecastEntrySchema = z
  .object({
    start: optionalTimestampSchema.optional(),
    from: optionalTimestampSchema.optional(),
    end: optionalTimestampSchema.optional(),
    to: optionalTimestampSchema.optional(),
    price: nullableNumberSchema.optional(),
    value: nullableNumberSchema.optional(),
    unit: optionalStringSchema.optional(),
    price_unit: optionalStringSchema.optional(),
    value_unit: optionalStringSchema.optional(),
    price_ct_per_kwh: nullableNumberSchema.optional(),
    price_with_fee_ct_per_kwh: nullableNumberSchema.optional(),
    price_with_fee_eur_per_kwh: nullableNumberSchema.optional(),
    value_ct_per_kwh: nullableNumberSchema.optional(),
    duration_hours: nullableNumberSchema.optional(),
    durationHours: nullableNumberSchema.optional(),
    duration_minutes: nullableNumberSchema.optional(),
    durationMinutes: nullableNumberSchema.optional(),
    era_id: optionalStringSchema.optional(),
    eraId: optionalStringSchema.optional(),
  })
  .catchall(z.unknown());

export type RawForecastEntry = z.infer<typeof rawForecastEntrySchema>;

export const rawSolarEntrySchema = z
  .object({
    start: optionalTimestampSchema.optional(),
    end: optionalTimestampSchema.optional(),
    energy_kwh: nullableNumberSchema.optional(),
    energy_wh: nullableNumberSchema.optional(),
    value: nullableNumberSchema.optional(),
    val: nullableNumberSchema.optional(),
    ts: optionalTimestampSchema.optional(),
    calibrated_power_w: nullableNumberSchema.optional(),
    raw_power_w: nullableNumberSchema.optional(),
    proxy_power_w: nullableNumberSchema.optional(),
    calibration_ratio: nullableNumberSchema.optional(),
    calibration_confidence: nullableNumberSchema.optional(),
  })
  .catchall(z.unknown());

export type RawSolarEntry = z.infer<typeof rawSolarEntrySchema>;

export type HistoryRawEntry = Record<string, unknown>;

export const historyPointSchema = z
  .object({
    timestamp: requiredTimestampSchema,
    battery_soc_percent: nullableNumberSchema,
    price_ct_per_kwh: nullableNumberSchema.optional(),
    price_eur_per_kwh: nullableNumberSchema,
    grid_power_w: nullableNumberSchema.optional().default(null),
    solar_power_w: nullableNumberSchema.optional().default(null),
    solar_forecast_power_w: nullableNumberSchema.optional().default(null),
    solar_energy_wh: nullableNumberSchema.optional().default(null),
    home_power_w: nullableNumberSchema.optional().default(null),
    ev_charge_power_w: nullableNumberSchema.optional().default(null),
    site_demand_power_w: nullableNumberSchema.optional().default(null),
  })
  .strip();

export type HistoryPoint = z.infer<typeof historyPointSchema>;

export const backtestResultSummarySchema = z.object({
  generated_at: requiredTimestampSchema,
  actual_total_cost_eur: z.number(),
  simulated_total_cost_eur: z.number(),
  simulated_start_soc_percent: z.number(),
  actual_final_soc_percent: z.number(),
  simulated_final_soc_percent: z.number(),
  soc_value_adjustment_eur: z.number(),
  adjusted_actual_cost_eur: z.number(),
  adjusted_simulated_cost_eur: z.number(),
  savings_eur: z.number(),
  avg_price_eur_per_kwh: z.number(),
  history_points_used: z.number().int().nonnegative(),
  span_hours: z.number().nonnegative(),
});

export type BacktestResultSummary = z.infer<typeof backtestResultSummarySchema>;

const costForecastSourceSchema = z.object({
  provider: z.string(),
  type: z.literal("cost"),
  payload: z.object({
    price_ct_per_kwh: z.number(),
    price_eur_per_kwh: z.number(),
    price_with_fee_ct_per_kwh: z.number(),
    price_with_fee_eur_per_kwh: z.number(),
    unit: z.string(),
  }),
});

const solarForecastSourceSchema = z.object({
  provider: z.string(),
  type: z.literal("solar"),
  payload: z.object({
    energy_wh: z.number(),
    average_power_w: z.number().optional(),
  }),
});

const forecastSourceSchema = z.union([costForecastSourceSchema, solarForecastSourceSchema]);
export type ForecastSourcePayload = z.infer<typeof forecastSourceSchema>;

export const forecastEraSchema = z.object({
  era_id: z.string(),
  start: optionalTimestampSchema.optional(),
  end: optionalTimestampSchema.optional(),
  duration_hours: nullableNumberSchema,
  sources: z.array(forecastSourceSchema),
});

export type ForecastEra = z.infer<typeof forecastEraSchema>;

const oracleEntrySchema = z.object({
  era_id: z.string(),
  start_soc_percent: nullableNumberSchema,
  end_soc_percent: nullableNumberSchema,
  target_soc_percent: nullableNumberSchema.optional(),
  grid_energy_wh: nullableNumberSchema,
  strategy: z.union([z.literal("charge"), z.literal("auto"), z.literal("hold")]),
});

export type OracleEntry = z.infer<typeof oracleEntrySchema>;

export const demandForecastEntrySchema = z.object({
  start: requiredTimestampSchema,
  end: optionalTimestampSchema.optional(),
  house_power_w: z.number().nonnegative(),
  baseline_house_power_w: z.number().nonnegative(),
  confidence: nullableNumberSchema.optional(),
  source: z.string(),
  model_version: optionalStringSchema.optional(),
});

export type DemandForecastEntry = z.infer<typeof demandForecastEntrySchema>;

export const snapshotPayloadSchema = z.object({
  timestamp: requiredTimestampSchema,
  interval_seconds: nullableNumberSchema,
  current_soc_percent: nullableNumberSchema,
  next_step_soc_percent: nullableNumberSchema,
  recommended_soc_percent: nullableNumberSchema,
  recommended_final_soc_percent: nullableNumberSchema,
  charge_efficiency_percent: nullableNumberSchema.optional(),
  discharge_efficiency_percent: nullableNumberSchema.optional(),
  current_mode: z.union([z.literal("charge"), z.literal("auto"), z.literal("hold")]).optional(),
  price_snapshot_ct_per_kwh: nullableNumberSchema.optional(),
  price_snapshot_eur_per_kwh: nullableNumberSchema,
  projected_cost_eur: nullableNumberSchema,
  baseline_cost_eur: nullableNumberSchema,
  basic_battery_cost_eur: nullableNumberSchema.optional(),
  active_control_savings_eur: nullableNumberSchema.optional(),
  projected_savings_eur: nullableNumberSchema,
  projected_grid_power_w: nullableNumberSchema,
  expected_feed_in_kwh: nullableNumberSchema.optional(),
  solar_forecast_discrepancy_w: nullableNumberSchema.optional(),
  solar_forecast_discrepancy_start: optionalTimestampSchema.optional(),
  solar_forecast_discrepancy_end: optionalTimestampSchema.optional(),
  forecast_hours: nullableNumberSchema,
  forecast_samples: nullableNumberSchema,
  forecast_eras: z.array(forecastEraSchema),
  demand_forecast: z.array(demandForecastEntrySchema),
  oracle_entries: z.array(oracleEntrySchema),
  history: z.array(historyPointSchema),
  warnings: z.array(z.string()),
  errors: z.array(z.string()),
});

export type SnapshotPayload = z.infer<typeof snapshotPayloadSchema>;

export const snapshotSummarySchema = snapshotPayloadSchema.pick({
  timestamp: true,
  interval_seconds: true,
  current_soc_percent: true,
  next_step_soc_percent: true,
  recommended_soc_percent: true,
  recommended_final_soc_percent: true,
  charge_efficiency_percent: true,
  discharge_efficiency_percent: true,
  current_mode: true,
  price_snapshot_ct_per_kwh: true,
  price_snapshot_eur_per_kwh: true,
  projected_cost_eur: true,
  baseline_cost_eur: true,
  basic_battery_cost_eur: true,
  active_control_savings_eur: true,
  projected_savings_eur: true,
  projected_grid_power_w: true,
  expected_feed_in_kwh: true,
  solar_forecast_discrepancy_w: true,
  solar_forecast_discrepancy_start: true,
  solar_forecast_discrepancy_end: true,
  forecast_hours: true,
  forecast_samples: true,
  warnings: true,
  errors: true,
});

export type SnapshotSummary = z.infer<typeof snapshotSummarySchema>;

export const historyResponseSchema = z.object({
  generated_at: requiredTimestampSchema,
  entries: z.array(historyPointSchema),
});

export type HistoryResponse = z.infer<typeof historyResponseSchema>;

export const forecastResponseSchema = z.object({
  generated_at: requiredTimestampSchema,
  eras: z.array(forecastEraSchema),
});

export type ForecastResponse = z.infer<typeof forecastResponseSchema>;

export const oracleResponseSchema = z.object({
  generated_at: requiredTimestampSchema,
  entries: z.array(oracleEntrySchema),
});

export type OracleResponse = z.infer<typeof oracleResponseSchema>;

export const demandForecastResponseSchema = z.object({
  generated_at: requiredTimestampSchema,
  entries: z.array(demandForecastEntrySchema),
});

export type DemandForecastResponse = z.infer<typeof demandForecastResponseSchema>;

export const forecastSlotInputSchema = z.object({
  start: requiredTimestampSchema,
  end: optionalTimestampSchema.optional(),
  price: nullableNumberSchema,
  unit: optionalStringSchema.optional(),
  price_ct_per_kwh: nullableNumberSchema,
  price_with_fee_ct_per_kwh: nullableNumberSchema.optional(),
  price_with_fee_eur_per_kwh: nullableNumberSchema.optional(),
  duration_hours: nullableNumberSchema,
  era_id: optionalStringSchema.optional(),
});

export const solarSlotInputSchema = z.object({
  start: requiredTimestampSchema,
  end: optionalTimestampSchema.optional(),
  energy_kwh: nullableNumberSchema,
});

export const batteryConfigSchema = z.object({
  capacity_kwh: nullableNumberSchema,
  max_charge_power_w: nullableNumberSchema,
  auto_mode_floor_soc: nullableNumberSchema.optional(),
  max_charge_power_solar_w: nullableNumberSchema.optional(),
  max_discharge_power_w: nullableNumberSchema.optional(),
  max_charge_soc_percent: nullableNumberSchema.optional(),
});

export const priceConfigSchema = z.object({
  grid_fee_eur_per_kwh: nullableNumberSchema.optional(),
  feed_in_tariff_eur_per_kwh: nullableNumberSchema.optional(),
});

export const logicConfigSchema = z.object({
  interval_seconds: nullableNumberSchema.optional(),
  min_hold_minutes: nullableNumberSchema.optional(),
  allow_battery_export: optionalBooleanSchema.optional(),
});

export const simulationConfigSchema = z.object({
  battery: batteryConfigSchema,
  price: priceConfigSchema,
  logic: logicConfigSchema,
});

export type SimulationConfig = z.infer<typeof simulationConfigSchema>;

export type PriceSlot = TariffSlot;
