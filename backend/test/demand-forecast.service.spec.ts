import { describe, expect, it } from "vitest";

import type { ForecastEra, HistoryPoint } from "@chargecaster/domain";
import { DemandForecastService } from "../src/config/demand-forecast.service";
import type { ConfigDocument } from "../src/config/schemas";
import type { WeatherService } from "../src/config/weather.service";
import type { LoadForecastInferenceService } from "../src/forecasting/load-forecast-inference.service";
import type { StorageService, WeatherHourRecord } from "../src/storage/storage.service";

function createConfig(): ConfigDocument {
  return {
    dry_run: true,
    location: {
      latitude: 48.235,
      longitude: 16.134,
      timezone: "Europe/Vienna",
    },
    battery: {
      capacity_kwh: 10,
      max_charge_power_w: 500,
    },
    price: {
      grid_fee_eur_per_kwh: 0.11,
    },
    logic: {
      interval_seconds: 300,
      min_hold_minutes: 0,
      allow_battery_export: false,
    },
  };
}

function createForecastEra(startIso: string, solarW: number, priceEurPerKwh: number, eraId: string): ForecastEra {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + 3_600_000);
  return {
    era_id: eraId,
    start: start.toISOString(),
    end: end.toISOString(),
    duration_hours: 1,
    sources: [
      {
        provider: "awattar",
        type: "cost",
        payload: {
          price_ct_per_kwh: priceEurPerKwh * 100,
          price_eur_per_kwh: priceEurPerKwh,
          price_with_fee_ct_per_kwh: (priceEurPerKwh + 0.11) * 100,
          price_with_fee_eur_per_kwh: priceEurPerKwh + 0.11,
          unit: "ct/kWh",
        },
      },
      {
        provider: "evcc",
        type: "solar",
        payload: {
          energy_wh: solarW,
          average_power_w: solarW,
        },
      },
    ],
  };
}

function createHistoryPoints(): HistoryPoint[] {
  const points: HistoryPoint[] = [];
  const startMs = new Date("2026-03-01T00:00:00.000Z").getTime();
  for (let hourOffset = 0; hourOffset < 24 * 7; hourOffset += 1) {
    const slotStart = startMs + (hourOffset * 3_600_000);
    const hour = new Date(slotStart).getUTCHours();
    const isEvening = hour >= 18 && hour <= 22;
    const isMorning = hour >= 6 && hour <= 8;
    const solar = hour >= 10 && hour <= 14 ? 1800 : 0;
    const home = 1200 + (isMorning ? 300 : 0) + (isEvening ? 900 : 0) + (solar > 0 ? -150 : 0);
    for (let minuteStep = 0; minuteStep < 12; minuteStep += 1) {
      points.push({
        timestamp: new Date(slotStart + minuteStep * 300_000).toISOString(),
        battery_soc_percent: 50,
        price_eur_per_kwh: 0.09 + hour / 1000,
        price_ct_per_kwh: (0.09 + hour / 1000) * 100,
        grid_power_w: Math.max(0, home - solar),
        solar_power_w: solar,
        solar_forecast_power_w: solar,
        solar_energy_wh: solar,
        home_power_w: home,
        ev_charge_power_w: 0,
        site_demand_power_w: home,
      });
    }
  }
  return points;
}

function createWeatherRows(startIso: string, hours: number): WeatherHourRecord[] {
  const rows: WeatherHourRecord[] = [];
  const startMs = new Date(startIso).getTime();
  for (let index = 0; index < hours; index += 1) {
    const timestamp = new Date(startMs + index * 3_600_000);
    const hour = timestamp.getUTCHours();
    rows.push({
      latitude: 48.235,
      longitude: 16.134,
      hourUtc: new Date(Date.UTC(
        timestamp.getUTCFullYear(),
        timestamp.getUTCMonth(),
        timestamp.getUTCDate(),
        hour,
      )).toISOString(),
      temperature2m: hour >= 10 && hour <= 14 ? 18 : 7,
      cloudCover: hour >= 10 && hour <= 14 ? 20 : 60,
      windSpeed10m: 8,
      precipitationMm: 0,
      source: "test",
      updatedAt: new Date().toISOString(),
    });
  }
  return rows;
}

function createService(history: HistoryPoint[], weatherRows: WeatherHourRecord[], inference?: Partial<LoadForecastInferenceService>): DemandForecastService {
  const storage = {
    listAllHistoryAsc: () => history.map((payload, index) => ({ id: index + 1, timestamp: payload.timestamp, payload })),
    listWeatherHours: (_lat: number, _lon: number, start: string, end: string) =>
      weatherRows.filter((row) => row.hourUtc >= start && row.hourUtc <= end),
    upsertWeatherHours: () => undefined,
  } as unknown as StorageService;
  const weatherService = {
    getWeatherHours: () => Promise.resolve(weatherRows),
  } as unknown as WeatherService;
  const inferenceService = {
    getActiveArtifact: () => null,
    predict: () => Promise.resolve(null),
    ...inference,
  } as unknown as LoadForecastInferenceService;
  return new DemandForecastService(storage, weatherService, inferenceService);
}

describe("DemandForecastService", () => {
  it("builds a hybrid fallback forecast when no model artifact is active", async () => {
    const forecast = await createService(
      createHistoryPoints(),
      createWeatherRows("2026-03-01T00:00:00.000Z", 24 * 8),
    ).buildForecast({
      config: createConfig(),
      forecastEras: [
        createForecastEra("2026-03-08T09:00:00.000Z", 900, 0.12, "era-1"),
        createForecastEra("2026-03-08T10:00:00.000Z", 1800, 0.11, "era-2"),
        createForecastEra("2026-03-08T11:00:00.000Z", 2100, 0.1, "era-3"),
      ],
      liveHomePowerW: 1450,
    });

    expect(forecast).toHaveLength(3);
    for (const entry of forecast) {
      expect(entry.house_power_w).toBeGreaterThan(0);
      expect(entry.baseline_house_power_w).toBeGreaterThan(0);
      expect(entry.confidence ?? 0).toBeGreaterThan(0);
      expect(entry.source).toBe("hybrid_history_weather");
    }
    expect(forecast[2]?.house_power_w ?? 0).toBeGreaterThan(800);
  });

  it("uses the active CatBoost artifact when inference is available", async () => {
    const service = createService(
      createHistoryPoints(),
      createWeatherRows("2026-03-01T00:00:00.000Z", 24 * 8),
      {
        getActiveArtifact: () => ({
          baseDir: "/tmp/models",
          currentDir: "/tmp/models/current",
          modelPath: "/tmp/models/current/model.cbm",
          manifestPath: "/tmp/models/current/manifest.json",
          metricsPath: "/tmp/models/current/metrics.json",
          trainingLogPath: "/tmp/models/current/training.log",
          manifest: {
            model_type: "catboost",
            model_version: "test-model-1",
            feature_schema_version: "v2_house_load_1",
            trained_at: "2026-03-13T00:00:00.000Z",
            training_window: {
              start: "2026-01-01T00:00:00.000Z",
              end: "2026-03-01T00:00:00.000Z",
            },
            history_row_count: 1000,
            hourly_row_count: 500,
            metrics_summary: {
              mae: 100,
              rmse: 150,
              p50_absolute_error: 80,
              p90_absolute_error: 200,
            },
            catboost_version: "1.2.8",
          },
        }),
        predict: () => Promise.resolve({
          predictions: [1337],
          artifact: {
            baseDir: "/tmp/models",
            currentDir: "/tmp/models/current",
            modelPath: "/tmp/models/current/model.cbm",
            manifestPath: "/tmp/models/current/manifest.json",
            metricsPath: "/tmp/models/current/metrics.json",
            trainingLogPath: "/tmp/models/current/training.log",
            manifest: {
              model_type: "catboost",
              model_version: "test-model-1",
              feature_schema_version: "v2_house_load_1",
              trained_at: "2026-03-13T00:00:00.000Z",
              training_window: {
                start: "2026-01-01T00:00:00.000Z",
                end: "2026-03-01T00:00:00.000Z",
              },
              history_row_count: 1000,
              hourly_row_count: 500,
              metrics_summary: {
                mae: 100,
                rmse: 150,
                p50_absolute_error: 80,
                p90_absolute_error: 200,
              },
              catboost_version: "1.2.8",
            },
          },
        }),
      },
    );

    const forecast = await service.buildForecast({
      config: createConfig(),
      forecastEras: [createForecastEra("2026-03-08T12:00:00.000Z", 2200, 0.09, "model-1")],
      liveHomePowerW: 1200,
    });

    expect(forecast).toHaveLength(1);
    expect(forecast[0]?.source).toBe("catboost_model");
    expect(forecast[0]?.model_version).toBe("test-model-1");
    expect(forecast[0]?.house_power_w).toBeGreaterThan(1200);
  });

  it("falls back to a cold-start baseline without history", async () => {
    const service = createService([], []);
    const forecast = await service.buildForecast({
      config: createConfig(),
      forecastEras: [createForecastEra("2026-03-08T12:00:00.000Z", 3000, 0.09, "cold-1")],
    });

    expect(forecast).toHaveLength(1);
    expect(forecast[0]?.house_power_w).toBeCloseTo(2200, 3);
    expect(forecast[0]?.baseline_house_power_w).toBeCloseTo(2200, 3);
    expect(forecast[0]?.source).toBe("cold_start");
  });
});
