import { z } from "zod";

import {
  nullableNumberSchema,
  optionalBooleanSchema,
  optionalNumberSchema,
  optionalStringSchema,
  optionalTimestampSchema,
  type UnknownRecord,
  unknownRecordSchema,
  RawForecastEntry,
  rawForecastEntrySchema,
  RawSolarEntry,
  rawSolarEntrySchema,
} from "@chargecaster/domain";

export const awattarConfigSchema = z.object({
  priority: z.number().int().nonnegative(),
  url: optionalStringSchema.optional(),
  max_hours: optionalNumberSchema.optional(),
}).strip();
export type AwattarConfig = z.infer<typeof awattarConfigSchema>;

export const entsoeNewConfigSchema = z.object({
  priority: z.number().int().nonnegative(),
  zone: optionalStringSchema.optional(),
  tz: optionalStringSchema.optional().default("CET"),
  max_hours: optionalNumberSchema.optional(),
  aggregate_hourly: optionalBooleanSchema.optional().default(false),
}).strip();
export type EntsoeNewConfig = z.infer<typeof entsoeNewConfigSchema>;

export const fromEvccConfigSchema = z.object({
  priority: z.number().int().nonnegative(),
}).strip();
export type FromEvccConfig = z.infer<typeof fromEvccConfigSchema>;

const configSectionSchema = z.object({
  enabled: optionalBooleanSchema.optional().default(true),
});

const froniusConfigSchema = configSectionSchema
  .extend({
    host: optionalStringSchema.optional(),
    user: optionalStringSchema.optional(),
    password: optionalStringSchema.optional(),
    batteries_path: optionalStringSchema.optional(),
    verify_tls: optionalBooleanSchema.optional(),
    timeout_s: optionalNumberSchema.optional(),
  })
  .strip();

const batteryConfigSchema = z
  .object({
    capacity_kwh: optionalNumberSchema.optional(),
    max_charge_power_w: optionalNumberSchema.optional(),
    auto_mode_floor_soc: optionalNumberSchema.optional(),
    max_charge_power_solar_w: optionalNumberSchema.optional(),
    max_discharge_power_w: optionalNumberSchema.optional(),
    max_charge_soc_percent: optionalNumberSchema.optional(),
  })
  .strip();

const priceConfigSchema = z
  .object({
    grid_fee_eur_per_kwh: optionalNumberSchema.optional(),
    feed_in_tariff_eur_per_kwh: optionalNumberSchema.optional(),
  })
  .strip();

const logicConfigSchema = z
  .object({
    interval_seconds: optionalNumberSchema.optional(),
    min_hold_minutes: optionalNumberSchema.optional(),
    house_load_w: optionalNumberSchema.optional(),
    allow_battery_export: optionalBooleanSchema.optional(),
  })
  .strip();

const solarConfigSchema = z
  .object({
    direct_use_ratio: optionalNumberSchema.optional(),
  })
  .strip();

const evccConfigSchema = configSectionSchema
  .extend({
    base_url: optionalStringSchema.optional(),
    token: optionalStringSchema.optional(),
    timeout_ms: optionalNumberSchema.optional(),
  })
  .strip();

const marketConfigSchema = z.object({
  awattar: awattarConfigSchema.optional(),
  entsoe: entsoeNewConfigSchema.optional(),
  from_evcc: fromEvccConfigSchema.optional(),
}).strip();

const loggingConfigSchema = z
  .object({
    level: optionalStringSchema.optional(),
  })
  .strict();

export const configDocumentSchema = z
  .object({
    dry_run: optionalBooleanSchema.optional().default(false),
    fronius: froniusConfigSchema.optional(),
    battery: batteryConfigSchema.optional(),
    price: priceConfigSchema.optional(),
    logic: logicConfigSchema.optional(),
    evcc: evccConfigSchema.optional(),
    market_data: marketConfigSchema.optional(),
    solar: solarConfigSchema.optional(),
    logging: loggingConfigSchema.optional(),
  })
  .strict();

export type ConfigDocument = z.infer<typeof configDocumentSchema>;

export interface ParsedEvccState {
  forecast: RawForecastEntry[];
  solarTimeseries: RawSolarEntry[];
  batterySoc: number | null;
  priceSnapshot: number | null;
  gridPowerW: number | null;
  solarPowerW: number | null;
  homePowerW: number | null;
}

const forecastArraySchema = z.array(rawForecastEntrySchema);
const solarTimeseriesSchema = z.array(rawSolarEntrySchema);

const evccStateSchema = z
  .object({
    forecast: z.unknown().optional(),
    site: unknownRecordSchema.optional(),
    battery: z.union([unknownRecordSchema, z.array(unknownRecordSchema)]).optional(),
    soc: optionalNumberSchema.optional(),
    batterySoc: optionalNumberSchema.optional(),
    grid: unknownRecordSchema.optional(),
    solar: unknownRecordSchema.optional(),
    gridPower: optionalNumberSchema.optional(),
    solarPower: optionalNumberSchema.optional(),
    pvPower: optionalNumberSchema.optional(),
    tariffGrid: optionalNumberSchema.optional(),
    tariffPriceLoadpoints: optionalNumberSchema.optional(),
    tariffPriceHome: optionalNumberSchema.optional(),
    gridPrice: optionalNumberSchema.optional(),
  })
  .passthrough();

const marketDataEntrySchema = z
  .object({
    start_timestamp: optionalTimestampSchema.optional(),
    end_timestamp: optionalTimestampSchema.optional(),
    marketprice: nullableNumberSchema.optional(),
    unit: optionalStringSchema.optional(),
    price_unit: optionalStringSchema.optional(),
    value_unit: optionalStringSchema.optional(),
    price_ct_per_kwh: nullableNumberSchema.optional(),
    price_with_fee_ct_per_kwh: nullableNumberSchema.optional(),
    price_with_fee_eur_per_kwh: nullableNumberSchema.optional(),
    duration_hours: nullableNumberSchema.optional(),
    duration_minutes: nullableNumberSchema.optional(),
  })
  .strip();

const marketDataContainerSchema = z
  .object({
    data: z.array(marketDataEntrySchema).optional(),
    items: z.array(marketDataEntrySchema).optional(),
    forecast: z.array(marketDataEntrySchema).optional(),
  })
  .passthrough();

const marketDataRootSchema = z.union([
  z.array(marketDataEntrySchema),
  marketDataContainerSchema,
]);

const pickFirstNumber = (...candidates: unknown[]): number | null => {
  for (const candidate of candidates) {
    const parsed = optionalNumberSchema.safeParse(candidate);
    if (parsed.success && parsed.data !== undefined) {
      return parsed.data;
    }
  }
  return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getFirstRecord = (value: unknown): UnknownRecord | null => {
  if (isRecord(value)) {
    return value as UnknownRecord;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (isRecord(item)) {
        return item as UnknownRecord;
      }
    }
  }
  return null;
};

const PRICE_UNITS = new Set([
  "ct/kwh",
  "cent/kwh",
  "€/kwh",
  "eur/kwh",
  "eur/mwh",
  "€/mwh",
  "ct/mwh",
]);

const isPriceLikeEntry = (entry: RawForecastEntry): boolean => {
  const hasExplicitPrice = typeof entry.price === "number" && Number.isFinite(entry.price);
  const hasPriceCt = typeof entry.price_ct_per_kwh === "number" && Number.isFinite(entry.price_ct_per_kwh);
  const hasPriceWithFeeCt = typeof entry.price_with_fee_ct_per_kwh === "number" && Number.isFinite(entry.price_with_fee_ct_per_kwh);
  const hasPriceWithFeeEur = typeof entry.price_with_fee_eur_per_kwh === "number" && Number.isFinite(entry.price_with_fee_eur_per_kwh);
  const unit = (entry.unit ?? entry.price_unit ?? entry.value_unit ?? "").toLowerCase().trim();
  const hasValueWithPriceUnit = PRICE_UNITS.has(unit) && typeof entry.value === "number" && Number.isFinite(entry.value);
  return hasExplicitPrice || hasPriceCt || hasPriceWithFeeCt || hasPriceWithFeeEur || hasValueWithPriceUnit;
};

const parseForecastValue = (value: unknown): RawForecastEntry[] => {
  const parsed = forecastArraySchema.safeParse(value);
  if (!parsed.success) {
    return [];
  }
  // Filter out non-price series such as CO2 arrays which otherwise look like numbers without price units.
  return parsed.data.filter(isPriceLikeEntry);
};

// Variant that accepts entries without explicit price units (used for known price arrays like `grid` and `planner`).
const parseForecastValueAll = (value: unknown): RawForecastEntry[] => {
  const parsed = forecastArraySchema.safeParse(value);
  return parsed.success ? parsed.data : [];
};

const parseSolarTimeseriesValue = (value: unknown): RawSolarEntry[] => {
  const parsed = solarTimeseriesSchema.safeParse(value);
  return parsed.success ? parsed.data : [];
};

export const parseConfigDocument = (input: unknown): ConfigDocument =>
  configDocumentSchema.parse(input ?? {});

export const parseMarketForecast = (input: unknown): RawForecastEntry[] => {
  if (input === null || input === undefined) {
    return [];
  }
  const parsed = marketDataRootSchema.safeParse(input);
  if (!parsed.success) {
    return [];
  }
  const entries: z.infer<typeof marketDataEntrySchema>[] = Array.isArray(parsed.data)
    ? parsed.data
    : parsed.data.data ?? parsed.data.items ?? parsed.data.forecast ?? [];

  return entries.map((entry) => {
    const normalized: RawForecastEntry = {
      start: entry.start_timestamp,
      end: entry.end_timestamp,
      price: entry.marketprice,
      unit: entry.unit ?? entry.price_unit ?? entry.value_unit ?? undefined,
      price_unit: entry.price_unit ?? undefined,
      value_unit: entry.value_unit ?? undefined,
      price_ct_per_kwh: entry.price_ct_per_kwh ?? null,
      price_with_fee_ct_per_kwh: entry.price_with_fee_ct_per_kwh ?? null,
      price_with_fee_eur_per_kwh: entry.price_with_fee_eur_per_kwh ?? null,
      duration_hours: entry.duration_hours ?? null,
      duration_minutes: entry.duration_minutes ?? null,
    };
    return normalized;
  });
};

export const parseEvccState = (input: unknown): ParsedEvccState => {
  const state = evccStateSchema.parse(input ?? {});

  const forecastValue = state.forecast;
  const forecast: RawForecastEntry[] = [];
  const solarTimeseries: RawSolarEntry[] = [];

  if (Array.isArray(forecastValue)) {
    forecast.push(...parseForecastValue(forecastValue));
  } else if (isRecord(forecastValue)) {
    const solarContainer = forecastValue.solar;
    if (isRecord(solarContainer)) {
      const timeseries = Array.isArray(solarContainer.timeseries)
        ? solarContainer.timeseries
        : [];
      solarTimeseries.push(...parseSolarTimeseriesValue(timeseries));
    }
    for (const [key, value] of Object.entries(forecastValue)) {
      if (key === "solar") {
        continue; // handled above
      }
      if (!Array.isArray(value)) {
        continue;
      }
      if (key === "grid" || key === "planner") {
        forecast.push(...parseForecastValueAll(value));
        continue;
      }
      if (key === "co2") {
        continue; // ignore CO2 arrays for price forecast
      }
      forecast.push(...parseForecastValue(value));
    }
  }

  const site: UnknownRecord = isRecord(state.site) ? (state.site as UnknownRecord) : {};
  const batteryRecord = getFirstRecord(state.battery);
  const siteBattery = getFirstRecord(site.battery);

  const batterySoc = pickFirstNumber(siteBattery?.soc, batteryRecord?.soc, site.batterySoc, state.batterySoc, state.soc);

  const gridRecord: UnknownRecord | null = getFirstRecord(state.grid);
  const solarRecord: UnknownRecord | null = getFirstRecord(state.solar);

  const gridPowerW = pickFirstNumber(
    gridRecord?.power,
    site.gridPower,
    state.gridPower,
  );

  const solarPowerW = pickFirstNumber(
    solarRecord?.power,
    site.pvPower,
    site.solarPower,
    state.solarPower,
    state.pvPower,
  );

  const stateObj = state as UnknownRecord;
  const homePowerW = pickFirstNumber(
    site.homePower,
    stateObj?.homePower,
  );

  const priceSnapshot = pickFirstNumber(
      site.tariffGrid,
      site.tariffPriceLoadpoints,
      site.tariffPriceHome,
      site.gridPrice,
      state.tariffGrid,
      state.tariffPriceLoadpoints,
      state.tariffPriceHome,
      state.gridPrice,
    ) ??
    (() => {
      for (const entry of forecast) {
        const price = entry.price ?? entry.value ?? null;
        if (price != null) {
          return price;
        }
      }
      return null;
    })();

  return {
    forecast,
    solarTimeseries,
    batterySoc,
    priceSnapshot,
    gridPowerW,
    solarPowerW,
    homePowerW,
  };
};
