import { describe, expect, it } from "vitest";

import type { RawForecastEntry, RawSolarEntry } from "@chargecaster/domain";
import { trimForecastEntriesToFuture, trimSolarEntriesToFuture } from "../src/config/simulation-preparation.service";

describe("trimForecastEntriesToFuture", () => {
  it("keeps the ongoing slot and trims it to start at now", () => {
    const nowMs = Date.UTC(2025, 0, 1, 12, 30, 0, 0);
    const entries: RawForecastEntry[] = [
      {
        start: "2025-01-01T12:00:00.000Z",
        end: "2025-01-01T13:00:00.000Z",
        price: 0.25,
      },
      {
        start: "2025-01-01T11:00:00.000Z",
        end: "2025-01-01T12:00:00.000Z",
        price: 0.2,
      },
      {
        start: "2025-01-01T13:00:00.000Z",
        end: "2025-01-01T14:00:00.000Z",
        price: 0.18,
      },
    ];

    const result = trimForecastEntriesToFuture(entries, nowMs);

    expect(result).toHaveLength(2);
    const [current, future] = result;
    expect(current.start).toBe(new Date(nowMs).toISOString());
    expect(current.end).toBe("2025-01-01T13:00:00.000Z");
    expect(current.duration_hours).toBeCloseTo(0.5, 6);
    expect(current.duration_minutes).toBeCloseTo(30, 3);
    expect(current.price).toBe(0.25);
    expect(future.start).toBe("2025-01-01T13:00:00.000Z");
    expect(future.end).toBe("2025-01-01T14:00:00.000Z");
    expect(future.duration_hours).toBeCloseTo(1, 6);
  });
});

describe("trimSolarEntriesToFuture", () => {
  it("scales the energy for the remaining portion of the current slot", () => {
    const nowMs = Date.UTC(2025, 0, 1, 12, 30, 0, 0);
    const entries: RawSolarEntry[] = [
      {
        start: "2025-01-01T12:00:00.000Z",
        end: "2025-01-01T13:00:00.000Z",
        energy_kwh: 1,
        energy_wh: 1000,
      },
    ];

    const result = trimSolarEntriesToFuture(entries, nowMs);

    expect(result).toHaveLength(1);
    const [current] = result;
    expect(current.start).toBe(new Date(nowMs).toISOString());
    expect(current.end).toBe("2025-01-01T13:00:00.000Z");
    expect(current.energy_kwh).toBeCloseTo(0.5, 6);
    expect(current.energy_wh).toBeCloseTo(500, 3);
  });
});
