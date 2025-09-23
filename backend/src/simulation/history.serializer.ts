import type { HistoryPoint, HistoryRawEntry } from "./types";

interface NumericSelector {
  key: string;
  factor?: number;
}

const TIMESTAMP_FALLBACK = () => new Date().toISOString();

function toNullableNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  return null;
}

function pickNumeric(entry: HistoryRawEntry, selectors: NumericSelector[]): number | null {
  for (const {key, factor = 1} of selectors) {
    if (!(key in entry)) {
      continue;
    }
    const raw = entry[key];
    const numeric = toNullableNumber(raw);
    if (numeric === null) {
      continue;
    }
    return numeric * factor;
  }
  return null;
}

function resolveTimestamp(entry: HistoryRawEntry): string {
  const candidates = ["timestamp", "time", "ts", "created_at", "createdAt"] as const;
  for (const key of candidates) {
    const raw = entry[key];
    if (!raw) {
      continue;
    }
    if (typeof raw === "string" && raw.length > 0) {
      return raw;
    }
    const numeric = toNullableNumber(raw);
    if (numeric !== null) {
      return new Date(numeric).toISOString();
    }
  }
  return TIMESTAMP_FALLBACK();
}

function resolvePriceValues(entry: HistoryRawEntry): {
  priceCt: number | null;
  priceEur: number | null;
} {
  const priceCt = pickNumeric(entry, [
    {key: "price_ct_per_kwh"},
    {key: "priceCtPerKwh"},
    {key: "price_ct"},
    {key: "priceCt"},
    {key: "price_cent"},
  ]);

  const priceEur = pickNumeric(entry, [
    {key: "price_eur_per_kwh"},
    {key: "priceEurPerKwh"},
    {key: "price_eur"},
    {key: "priceEur"},
    {key: "price"},
  ]);

  if (priceCt !== null) {
    return {priceCt, priceEur: priceEur ?? priceCt / 100};
  }

  if (priceEur !== null) {
    return {priceCt: priceEur * 100, priceEur};
  }

  return {priceCt: null, priceEur: null};
}

function resolveBatterySoc(entry: HistoryRawEntry): number | null {
  return pickNumeric(entry, [
    {key: "battery_soc_percent"},
    {key: "batterySocPercent"},
    {key: "soc_percent"},
    {key: "soc"},
    {key: "state_of_charge"},
    {key: "stateOfCharge"},
  ]);
}

export function normalizeHistoryEntry(entry: HistoryRawEntry): HistoryPoint {
  const timestamp = resolveTimestamp(entry);
  const batterySoc = resolveBatterySoc(entry);
  const {priceCt, priceEur} = resolvePriceValues(entry);

  const gridPowerW = pickNumeric(entry, [
    {key: "grid_power_w"},
    {key: "gridPowerW"},
    {key: "grid_power"},
    {key: "gridPower"},
    {key: "grid_import_power"},
    {key: "gridImportPower"},
    {key: "grid_power_kw", factor: 1000},
    {key: "gridPowerKw", factor: 1000},
  ]);

  const gridEnergyWh = pickNumeric(entry, [
    {key: "grid_energy_wh"},
    {key: "gridEnergyWh"},
    {key: "grid_energy_w"},
    {key: "gridEnergyW"},
    {key: "grid_energy_kwh", factor: 1000},
    {key: "gridEnergyKwh", factor: 1000},
  ]);

  const solarPowerW = pickNumeric(entry, [
    {key: "solar_power_w"},
    {key: "solarPowerW"},
    {key: "solar_power"},
    {key: "solarPower"},
    {key: "pv_power_w"},
    {key: "pvPowerW"},
    {key: "pv_power"},
    {key: "pvPower"},
    {key: "pv_kw", factor: 1000},
    {key: "pvKw", factor: 1000},
    {key: "solar_kw", factor: 1000},
    {key: "solarKw", factor: 1000},
  ]);

  const solarEnergyWh = pickNumeric(entry, [
    {key: "solar_energy_wh"},
    {key: "solarEnergyWh"},
    {key: "pv_energy_wh"},
    {key: "pvEnergyWh"},
    {key: "solar_energy_kwh", factor: 1000},
    {key: "solarEnergyKwh", factor: 1000},
    {key: "pv_energy_kwh", factor: 1000},
    {key: "pvEnergyKwh", factor: 1000},
  ]);

  return {
    timestamp,
    battery_soc_percent: batterySoc,
    price_ct_per_kwh: priceCt,
    price_eur_per_kwh: priceEur,
    grid_power_w: gridPowerW,
    grid_energy_w: gridEnergyWh,
    solar_power_w: solarPowerW,
    solar_energy_wh: solarEnergyWh,
  };
}

export function normalizeHistoryList(entries: HistoryRawEntry[]): HistoryPoint[] {
  return entries
    .map((entry) => normalizeHistoryEntry(entry))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}
