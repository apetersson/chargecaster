import { describe, expect, it } from "vitest";
import type { RawSolarEntry } from "@chargecaster/domain";

import { SolarForecastCalibrationService } from "../src/config/solar-forecast-calibration.service";
import type { ConfigDocument } from "../src/config/schemas";
import type { SolarArrayConfig, WeatherService } from "../src/config/weather.service";
import type { StorageService } from "../src/storage/storage.service";

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
        kwp: 5,
        dec: 15,
        az: -90,
      },
      {
        kwp: 5,
        dec: 15,
        az: 90,
      },
    ],
  };
}

function buildHistory() {
  const entries: Array<{ id: number; timestamp: string; payload: Record<string, unknown> }> = [];
  let id = 1;
  for (let day = 1; day <= 4; day += 1) {
    for (const hour of [10, 11, 12, 13, 14]) {
      const proxySolarW = hour === 12 ? 4000 : 2600;
      const measuredSolarW = proxySolarW * 0.8;
      const slotStart = Date.UTC(2026, 2, day, hour, 0, 0, 0);
      for (let step = 0; step < 12; step += 1) {
        entries.push({
          id,
          timestamp: new Date(slotStart + step * 300_000).toISOString(),
          payload: {
            timestamp: new Date(slotStart + step * 300_000).toISOString(),
            battery_soc_percent: 50,
            price_eur_per_kwh: 0.12,
            solar_power_w: measuredSolarW,
            home_power_w: 1500,
          },
        });
        id += 1;
      }
    }
  }
  return entries;
}

function buildProxyRows(arrays: SolarArrayConfig[]) {
  const rows: Array<{
    latitude: number;
    longitude: number;
    kwp: number;
    tilt: number;
    azimuth: number;
    hourUtc: string;
    globalTiltedIrradiance: number | null;
    expectedPowerW: number | null;
    source: string;
    updatedAt: string;
  }> = [];
  for (const arrayConfig of arrays) {
    for (let day = 1; day <= 5; day += 1) {
      for (const hour of [10, 11, 12, 13, 14]) {
        const expectedPowerW = hour === 12 ? 2000 : 1300;
        rows.push({
          latitude: arrayConfig.latitude,
          longitude: arrayConfig.longitude,
          kwp: arrayConfig.kwp,
          tilt: arrayConfig.tilt,
          azimuth: arrayConfig.azimuth,
          hourUtc: new Date(Date.UTC(2026, 2, day, hour, 0, 0, 0)).toISOString(),
          globalTiltedIrradiance: expectedPowerW / arrayConfig.kwp,
          expectedPowerW,
          source: "test",
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }
  return rows;
}

describe("SolarForecastCalibrationService", () => {
  it("scales future solar slots toward the learned site-specific production ratio", async () => {
    const config = createConfig();
    const latitude = config.location?.latitude ?? 0;
    const longitude = config.location?.longitude ?? 0;
    const arrays: SolarArrayConfig[] = (config.solar ?? []).map((entry) => ({
      latitude,
      longitude,
      kwp: entry.kwp ?? 0,
      tilt: entry.dec ?? 0,
      azimuth: entry.az ?? 0,
      timezone: "Europe/Vienna",
    }));
    const proxyRows = buildProxyRows(arrays);
    const storage = {
      listAllHistoryAsc: () => buildHistory(),
    } as unknown as StorageService;
    const weatherService = {
      getSolarProxyHours: () => Promise.resolve(proxyRows),
    } as unknown as WeatherService;
    const service = new SolarForecastCalibrationService(storage, weatherService);

    const rawForecast: RawSolarEntry[] = [
      {
        start: "2026-03-05T12:00:00.000Z",
        end: "2026-03-05T13:00:00.000Z",
        energy_wh: 4000,
      },
    ];

    const calibrated = await service.calibrateForecast(config, rawForecast);

    expect(calibrated).toHaveLength(1);
    expect(calibrated[0]?.energy_wh ?? 0).toBeLessThan(4000);
    expect(Number(calibrated[0]?.calibration_ratio ?? 0)).toBeGreaterThan(0.7);
    expect(Number(calibrated[0]?.calibration_ratio ?? 0)).toBeLessThan(0.9);
    expect(Number(calibrated[0]?.proxy_power_w ?? 0)).toBeCloseTo(4000, 3);
  });
});
