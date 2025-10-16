import { normalizePriceSlots } from "../../simulation/simulation.service";
import type { RawForecastEntry, SimulationConfig } from "../../simulation/types";
import { parseTimestamp } from "../../simulation/solar";

type WithFromTo = RawForecastEntry & { from?: unknown; to?: unknown };

export function clampHorizon(entries: RawForecastEntry[], maxHours: number): RawForecastEntry[] {
  if (!Array.isArray(entries) || !entries.length) return [];
  const now = Date.now();
  const endLimit = now + Math.max(1, maxHours) * 3_600_000;
  return entries.filter((e) => {
    const ext = e as WithFromTo;
    const start = parseTimestamp(ext.start ?? ext.from ?? null);
    return !!start && start.getTime() <= endLimit && start.getTime() >= now - 3_600_000;
  });
}

export function derivePriceSnapshotFromForecast(
  forecast: RawForecastEntry[],
  config: SimulationConfig,
): number | null {
  if (!forecast.length) return null;
  const slots = normalizePriceSlots(forecast);
  if (!slots.length) return null;
  const base = slots[0]?.price;
  if (typeof base !== "number" || Number.isNaN(base)) return null;
  const gridFee = config.price?.grid_fee_eur_per_kwh ?? 0;
  return base + gridFee;
}
