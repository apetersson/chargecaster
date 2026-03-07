import type { RawForecastEntry } from "@chargecaster/domain";
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
