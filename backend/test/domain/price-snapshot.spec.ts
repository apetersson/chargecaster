import { describe, expect, it } from "vitest";

import { derivePriceSnapshot, EnergyPrice, normalizePriceSlots, type RawForecastEntry } from "@chargecaster/domain";

describe("derivePriceSnapshot", () => {
  it("prefers the currently active slot over an earlier past slot", () => {
    const forecast: RawForecastEntry[] = [
      {
        start: "2026-04-01T00:00:00.000Z",
        end: "2026-04-01T01:00:00.000Z",
        price: 0.2542,
        unit: "EUR/kWh",
      },
      {
        start: "2026-04-01T01:00:00.000Z",
        end: "2026-04-01T02:00:00.000Z",
        price: 0.2046,
        unit: "EUR/kWh",
      },
      {
        start: "2026-04-01T02:00:00.000Z",
        end: "2026-04-01T03:00:00.000Z",
        price: 0.2235,
        unit: "EUR/kWh",
      },
    ];

    const slots = normalizePriceSlots(forecast);
    const snapshot = derivePriceSnapshot(
      slots,
      EnergyPrice.fromEurPerKwh(0.02),
      Date.parse("2026-04-01T01:25:00.000Z"),
    );

    expect(snapshot?.ctPerKwh).toBeCloseTo(22.46, 6);
  });

  it("falls back to the next upcoming slot when the current time is before the forecast horizon", () => {
    const forecast: RawForecastEntry[] = [
      {
        start: "2026-04-01T02:00:00.000Z",
        end: "2026-04-01T03:00:00.000Z",
        price: 0.2035,
        unit: "EUR/kWh",
      },
    ];

    const slots = normalizePriceSlots(forecast);
    const snapshot = derivePriceSnapshot(
      slots,
      EnergyPrice.fromEurPerKwh(0.02),
      Date.parse("2026-04-01T01:25:00.000Z"),
    );

    expect(snapshot?.ctPerKwh).toBeCloseTo(22.35, 6);
  });
});
