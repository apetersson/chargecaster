import { describe, expect, it } from "vitest";

import { OpenMeteoSolarForecastService } from "../src/config/open-meteo-solar-forecast.service";
import type { ConfigDocument } from "../src/config/schemas";
import type { WeatherService } from "../src/config/weather.service";

function createConfig(): ConfigDocument {
  return {
    dry_run: true,
    location: {
      latitude: 48.235,
      longitude: 16.134,
      timezone: "Europe/Vienna",
    },
    solar: [
      {
        lat: 48.23,
        lon: 16.14,
        kwp: 5,
        dec: 15,
        az: -90,
      },
      {
        lat: 48.23,
        lon: 16.14,
        kwp: 5,
        dec: 15,
        az: 90,
      },
    ],
    market_data: {
      awattar: {
        priority: 1,
        max_hours: 48,
      },
    },
  };
}

describe("OpenMeteoSolarForecastService", () => {
  it("builds hourly solar forecast slots from summed panel proxies", async () => {
    const weatherService = {
      getSolarProxyHours: () => Promise.resolve([
        {
          latitude: 48.23,
          longitude: 16.14,
          kwp: 5,
          tilt: 15,
          azimuth: -90,
          hourUtc: "2026-03-13T10:00:00.000Z",
          globalTiltedIrradiance: 200,
          expectedPowerW: 800,
          source: "forecast",
          updatedAt: "2026-03-13T09:00:00.000Z",
        },
        {
          latitude: 48.23,
          longitude: 16.14,
          kwp: 5,
          tilt: 15,
          azimuth: 90,
          hourUtc: "2026-03-13T10:00:00.000Z",
          globalTiltedIrradiance: 220,
          expectedPowerW: 900,
          source: "forecast",
          updatedAt: "2026-03-13T09:00:00.000Z",
        },
      ]),
    } as unknown as WeatherService;
    const service = new OpenMeteoSolarForecastService(weatherService);

    const result = await service.collect(createConfig(), [], new Date("2026-03-13T10:12:00.000Z"));

    expect(result).toHaveLength(1);
    expect(result[0]?.start).toBe("2026-03-13T10:00:00.000Z");
    expect(result[0]?.energy_wh).toBeCloseTo(1700, 3);
    expect(result[0]?.provider).toBe("open_meteo");
  });

  it("fails soft and returns no slots when Open-Meteo is unavailable", async () => {
    const warnings: string[] = [];
    const weatherService = {
      getSolarProxyHours: () => Promise.reject(new Error("network down")),
    } as unknown as WeatherService;
    const service = new OpenMeteoSolarForecastService(weatherService);

    const result = await service.collect(createConfig(), warnings, new Date("2026-03-13T10:12:00.000Z"));

    expect(result).toEqual([]);
    expect(warnings[0]).toContain("Open-Meteo solar forecast failed");
  });
});
