import { describe, expect, it } from "vitest";

import type { RawForecastEntry } from "@chargecaster/domain";
import { ForecastAssemblyService } from "../src/config/forecast-assembly.service";
import { normalizePriceSlots } from "../src/simulation/simulation.service";

describe("ForecastAssemblyService price normalization", () => {
  const service = new ForecastAssemblyService();

  it("converts cost sources to EUR per kWh for simulation", () => {
    const start = new Date(Date.UTC(2025, 0, 1, 12, 0, 0)).toISOString();
    const end = new Date(Date.UTC(2025, 0, 1, 13, 0, 0)).toISOString();

    const canonicalForecast: RawForecastEntry[] = [
      {
        start,
        end,
        price_ct_per_kwh: 18.786,
      },
    ];

    const marketForecast: RawForecastEntry[] = [
      {
        start,
        end,
        price: 18.786,
        unit: "ct/kWh",
      },
    ];

    const {forecastEntries} = service.buildForecastEras(canonicalForecast, [], marketForecast, [], 0);

    expect(forecastEntries).toHaveLength(1);
    const [entry] = forecastEntries;
    expect(entry.price).toBeCloseTo(0.18786, 6);
    expect(entry.unit).toBe("EUR/kWh");

    const slots = normalizePriceSlots(forecastEntries);
    expect(slots).toHaveLength(1);
    expect(slots[0].price).toBeCloseTo(0.18786, 6);
  });
});
