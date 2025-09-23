import { describe, expect, it } from "vitest";

import { ConfigSyncService } from "../src/config/config-sync.service";
import type { SimulationService } from "../src/simulation/simulation.service";
import { normalizePriceSlots } from "../src/simulation/simulation.service";
import type { FroniusService } from "../src/fronius/fronius.service";
import type { RawForecastEntry, RawSolarEntry } from "../src/simulation/types";

describe("ConfigSyncService price normalization", () => {
  const simulation = {
    runSimulation: () => {
      throw new Error("not needed for test");
    },
  } as unknown as SimulationService;
  const fronius = {
    applyOptimization: async () => Promise.resolve({errorMessage: null}),
  } as unknown as FroniusService;
  const service = new ConfigSyncService(simulation, fronius);

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

    const { forecastEntries } = (service as unknown as {
      buildForecastEras(
        canonicalForecast: RawForecastEntry[],
        evccForecast: RawForecastEntry[],
        marketForecast: RawForecastEntry[],
        solarForecast: RawSolarEntry[],
      ): { forecastEntries: RawForecastEntry[] };
    }).buildForecastEras(canonicalForecast, [], marketForecast, []);

    expect(forecastEntries).toHaveLength(1);
    const [entry] = forecastEntries;
    expect(entry.price).toBeCloseTo(0.18786, 6);
    expect(entry.unit).toBe("EUR/kWh");

    const slots = normalizePriceSlots(forecastEntries);
    expect(slots).toHaveLength(1);
    expect(slots[0].price).toBeCloseTo(0.18786, 6);
  });
});
