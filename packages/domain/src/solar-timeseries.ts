import { Duration } from "./duration.js";
import { Energy } from "./energy.js";
import { Power } from "./power.js";
import { TimeSlot } from "./time-slot.js";

export interface RawSolarTimeseriesPoint {
  ts?: string | number | Date | null;
  start?: string | number | Date | null;
  end?: string | number | Date | null;
  energy_kwh?: number | null;
  energy_wh?: number | null;
  value?: number | null;
  val?: number | null;
  unit?: string | null;
  value_unit?: string | null;
  power_unit?: string | null;
  [key: string]: unknown;
}

export interface NormalizedSolarSample {
  slot: TimeSlot;
  averagePower: Power;
  energy: Energy;
}

const SLOT_DURATION_MS = 3_600_000;

export function parseTemporal(value: string | number | Date | null | undefined): Date | null {
  if (value == null) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

export function normaliseUnit(unit: string | null | undefined): string | null {
  if (typeof unit !== "string") {
    return null;
  }
  const trimmed = unit.trim();
  return trimmed.length ? trimmed.toLowerCase() : null;
}

export function normaliseSolarTimeseries(points: RawSolarTimeseriesPoint[]): NormalizedSolarSample[] {
  const samples: NormalizedSolarSample[] = [];
  if (!Array.isArray(points) || !points.length) {
    return samples;
  }

  let previousDurationMs: number | null = null;

  for (let index = 0; index < points.length; index += 1) {
    const current = points[index] ?? {};
    const next = index + 1 < points.length ? points[index + 1] ?? {} : undefined;

    const start = parseTemporal(current.ts ?? current.start);
    if (!start) {
      continue;
    }

    const nextStart = parseTemporal(next?.ts ?? next?.start);
    let end = parseTemporal(current.end);
    if (!end && nextStart) {
      end = nextStart;
    }

    const fallbackDurationMs = previousDurationMs ?? SLOT_DURATION_MS;
    const resolvedEnd = end ?? new Date(start.getTime() + fallbackDurationMs);

    if (resolvedEnd.getTime() <= start.getTime()) {
      continue;
    }

    const slot = TimeSlot.fromDates(start, resolvedEnd);
    previousDurationMs = slot.end.getTime() - slot.start.getTime();
    const duration = slot.duration;

    const explicitEnergyKwh = typeof current.energy_kwh === "number" ? current.energy_kwh : null;
    const explicitEnergyWh = typeof current.energy_wh === "number" ? current.energy_wh : null;
    const explicitUnit = normaliseUnit(current.unit ?? current.value_unit ?? current.power_unit);

    let energy = explicitEnergyKwh != null
      ? Energy.fromKilowattHours(explicitEnergyKwh)
      : explicitEnergyWh != null
        ? Energy.fromWattHours(explicitEnergyWh)
        : null;

    if (energy === null) {
      const rawPower = resolvePowerValue(current, explicitUnit);
      if (rawPower !== null) {
        energy = Energy.fromPowerAndDuration(rawPower, duration);
      }
    }

    if (energy === null || energy.wattHours <= 0) {
      continue;
    }

    const averagePower = energy.divideByDuration(duration);
    samples.push({slot, averagePower, energy});
  }

  return samples;
}

function resolvePowerValue(point: RawSolarTimeseriesPoint, unitHint: string | null): Power | null {
  const candidates = [point.value, point.val, (point as {power?: number}).power, (point as {power_w?: number}).power_w];

  for (const candidate of candidates) {
    if (typeof candidate !== "number" || Number.isNaN(candidate)) {
      continue;
    }
    return normalisePower(candidate, unitHint);
  }
  return null;
}

function normalisePower(value: number, unitHint: string | null): Power {
  if (unitHint === "kw" || unitHint === "kilowatt" || unitHint === "kilowatts") {
    return Power.fromKilowatts(value);
  }
  if (unitHint === "mw" || unitHint === "megawatt" || unitHint === "megawatts") {
    return Power.fromWatts(value * 1_000_000);
  }
  if (unitHint === "w" || unitHint === "watt" || unitHint === "watts") {
    return Power.fromWatts(value);
  }

  // No explicit unit; infer based on magnitude.
  // Empirically: EVCC often reports small decimals in kW (e.g. 0.3–1.2),
  // while larger integers represent W (e.g. 150, 1200, 2500).
  // Values around sunset like 30.4 should be treated as 30.4 W, not kW.
  if (Math.abs(value) < 2) {
    return Power.fromKilowatts(value);
  }
  return Power.fromWatts(value);
}

export interface SolarForecastSlot {
  start: string;
  end: string;
  energy_wh: number;
  average_power_w: number;
}

export function toSolarForecastSlots(samples: NormalizedSolarSample[]): SolarForecastSlot[] {
  return samples.map((sample) => ({
    start: sample.slot.start.toISOString(),
    end: sample.slot.end.toISOString(),
    energy_wh: sample.energy.wattHours,
    average_power_w: sample.averagePower.watts,
  }));
}
