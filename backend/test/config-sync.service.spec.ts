import { describe, expect, it } from "vitest";

import { normalizePriceSlots, type RawForecastEntry } from "@chargecaster/domain";
import { ForecastAssemblyService } from "../src/config/forecast-assembly.service";

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

    const {forecastEntries} = service.buildForecastEras(canonicalForecast, marketForecast, [], [], 0);

    expect(forecastEntries).toHaveLength(1);
    const [entry] = forecastEntries;
    expect(entry.price).toBeCloseTo(0.18786, 6);
    expect(entry.unit).toBe("EUR/kWh");

    const slots = normalizePriceSlots(forecastEntries);
    expect(slots).toHaveLength(1);
    expect(slots[0].price).toBeCloseTo(0.18786, 6);
  });

  it("adds accurate and guesstimate price sources beside the canonical planning price", () => {
    const start = new Date(Date.UTC(2025, 0, 1, 12, 0, 0)).toISOString();
    const end = new Date(Date.UTC(2025, 0, 1, 13, 0, 0)).toISOString();

    const { eras } = service.buildForecastEras(
      [
        {
          start,
          end,
          price: 0.18,
          unit: "EUR/kWh",
          provider: "awattar",
        },
      ],
      [
        {
          start,
          end,
          price: 0.18,
          unit: "EUR/kWh",
          provider: "awattar",
        },
      ],
      [
        {
          start,
          end,
          price: 0.205,
          unit: "EUR/kWh",
          provider: "synthetic",
        },
      ],
      [],
      0.1,
    );

    expect(eras).toHaveLength(1);
    const costProviders = eras[0]?.sources.filter((source) => source.type === "cost").map((source) => source.provider);
    expect(costProviders).toEqual(["canonical", "awattar", "synthetic"]);
  });

  it("preserves the solar forecast provider on era sources", () => {
    const start = new Date(Date.UTC(2025, 0, 1, 12, 0, 0)).toISOString();
    const end = new Date(Date.UTC(2025, 0, 1, 13, 0, 0)).toISOString();

    const canonicalForecast: RawForecastEntry[] = [
      {
        start,
        end,
        price: 0.18,
        unit: "EUR/kWh",
      },
    ];

    const { eras } = service.buildForecastEras(
      canonicalForecast,
      [],
      [],
      [
        {
          start,
          end,
          energy_wh: 1200,
          provider: "open_meteo",
        },
      ],
      0,
    );

    expect(eras).toHaveLength(1);
    expect(eras[0]?.sources.find((source) => source.type === "solar")?.provider).toBe("open_meteo");
  });
});
