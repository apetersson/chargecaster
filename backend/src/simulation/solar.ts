import {
  normaliseSolarTimeseries,
  parseTemporal,
  type RawSolarTimeseriesPoint,
} from "@chargecaster/domain";

import type { RawSolarEntry } from "@chargecaster/domain";

export const parseTimestamp = (value: unknown): Date | null => {
  const parsed = parseTemporal(value as string | number | Date | null | undefined);
  return parsed ?? null;
};

export const buildSolarForecastFromTimeseries = (timeseries: RawSolarEntry[]): RawSolarEntry[] => {
  if (!Array.isArray(timeseries) || timeseries.length === 0) {
    return [];
  }
  // Pre-normalise ambiguous unit samples: when there is no explicit energy_kwh/energy_wh
  // and no unit present, infer kW only for small decimal magnitudes; otherwise treat as W.
  const hinted: RawSolarTimeseriesPoint[] = timeseries.map((entry) => {
    const hasEnergy = typeof entry.energy_kwh === "number" || typeof entry.energy_wh === "number";
    if (hasEnergy) {
      return entry as unknown as RawSolarTimeseriesPoint;
    }
    const rawVal = typeof entry.value === "number"
      ? entry.value
      : typeof entry.val === "number"
        ? entry.val
        : null;
    if (rawVal == null || !Number.isFinite(rawVal)) {
      return entry as unknown as RawSolarTimeseriesPoint;
    }
    // const power_unit = Math.abs(rawVal) < 2 ? "kW" : "W";
    const power_unit = "W";
    return {...(entry as Record<string, unknown>), power_unit} as RawSolarTimeseriesPoint;
  });

  return normaliseSolarTimeseries(hinted).map((sample) => ({
    start: sample.slot.start.toISOString(),
    end: sample.slot.end.toISOString(),
    energy_kwh: sample.energy.kilowattHours,
  }));
};
