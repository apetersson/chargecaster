import type { RawSolarEntry } from "./types";

const SLOT_DURATION_MS = 3_600_000;

export const parseTimestamp = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return new Date(value.getTime());
  }
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const timestamp = value > 1e12 ? value : value * 1000;
    return new Date(timestamp);
  }
  return null;
};

export const buildSolarForecastFromTimeseries = (timeseries: RawSolarEntry[]): RawSolarEntry[] => {
  if (!timeseries.length) {
    return [];
  }

  const entries: RawSolarEntry[] = [];

  for (let index = 0; index < timeseries.length; index += 1) {
    const item = timeseries[index];
    const startIso = (item.ts ?? item.start) ?? null;
    const startDate = parseTimestamp(startIso);
    if (!startDate) {
      continue;
    }

    const next = index + 1 < timeseries.length ? timeseries[index + 1] : undefined;
    const endIso = (next?.ts ?? next?.start ?? item.end) ?? null;
    const endDate = parseTimestamp(endIso) ?? new Date(startDate.getTime() + SLOT_DURATION_MS);

    const durationMs = endDate.getTime() - startDate.getTime();
    if (!(durationMs > 0)) {
      continue;
    }

    let energyKwh = typeof item.energy_kwh === "number" ? item.energy_kwh : null;
    if (energyKwh === null) {
      const energyWh = typeof item.energy_wh === "number" ? item.energy_wh : null;
      if (energyWh !== null) {
        energyKwh = energyWh / 1000;
      }
    }

    if (energyKwh === null) {
      const rawPower =
        typeof item.value === "number"
          ? item.value
          : typeof item.val === "number"
            ? item.val
            : null;
      if (rawPower !== null) {
        let powerKw = rawPower;
        if (powerKw > 1000) {
          powerKw /= 1000;
        }
        const durationHours = durationMs / SLOT_DURATION_MS;
        energyKwh = powerKw * durationHours;
      }
    }

    if (energyKwh === null || !Number.isFinite(energyKwh) || energyKwh <= 0) {
      continue;
    }

    entries.push({
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      energy_kwh: energyKwh,
    });
  }

  return entries;
};
