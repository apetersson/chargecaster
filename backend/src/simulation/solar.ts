import { normaliseSolarTimeseries, parseTemporal } from "@batteryctl/domain";

import type { RawSolarEntry } from "./types";

export const parseTimestamp = (value: unknown): Date | null => {
  const parsed = parseTemporal(value as string | number | Date | null | undefined);
  return parsed ?? null;
};

export const buildSolarForecastFromTimeseries = (timeseries: RawSolarEntry[]): RawSolarEntry[] => {
  if (!Array.isArray(timeseries) || timeseries.length === 0) {
    return [];
  }

  return normaliseSolarTimeseries(timeseries).map((sample) => ({
    start: sample.slot.start.toISOString(),
    end: sample.slot.end.toISOString(),
    energy_kwh: sample.energy.kilowattHours,
  }));
};
