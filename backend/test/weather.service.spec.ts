import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WeatherService, resetOpenMeteoLocalRateLimitForTests, type SolarArrayConfig, type WeatherLocation } from "../src/config/weather.service";
import type { ProviderCooldownRecord, SolarProxyHourRecord, StorageService, WeatherHourRecord } from "../src/storage/storage.service";

function createStorageStub(params?: {
  weather?: WeatherHourRecord[];
  solar?: SolarProxyHourRecord[];
}): StorageService {
  const weatherCache = [...(params?.weather ?? [])];
  const solarCache = [...(params?.solar ?? [])];
  const cooldowns = new Map<string, ProviderCooldownRecord>();

  return {
    listWeatherHours: (latitude: number, longitude: number, startInclusive: string, endInclusive: string) =>
      weatherCache.filter((entry) =>
        entry.latitude === latitude
        && entry.longitude === longitude
        && entry.hourUtc >= startInclusive
        && entry.hourUtc <= endInclusive
      ),
    upsertWeatherHours: (entries: Omit<WeatherHourRecord, "updatedAt">[]) => {
      const updatedAt = new Date().toISOString();
      for (const entry of entries) {
        const index = weatherCache.findIndex((candidate) =>
          candidate.latitude === entry.latitude
          && candidate.longitude === entry.longitude
          && candidate.hourUtc === entry.hourUtc
        );
        const normalized: WeatherHourRecord = {...entry, updatedAt};
        if (index >= 0) {
          weatherCache[index] = normalized;
        } else {
          weatherCache.push(normalized);
        }
      }
    },
    listSolarProxyHours: (
      latitude: number,
      longitude: number,
      kwp: number,
      tilt: number,
      azimuth: number,
      startInclusive: string,
      endInclusive: string,
    ) =>
      solarCache.filter((entry) =>
        entry.latitude === latitude
        && entry.longitude === longitude
        && entry.kwp === kwp
        && entry.tilt === tilt
        && entry.azimuth === azimuth
        && entry.hourUtc >= startInclusive
        && entry.hourUtc <= endInclusive
      ),
    upsertSolarProxyHours: (entries: Omit<SolarProxyHourRecord, "updatedAt">[]) => {
      const updatedAt = new Date().toISOString();
      for (const entry of entries) {
        const index = solarCache.findIndex((candidate) =>
          candidate.latitude === entry.latitude
          && candidate.longitude === entry.longitude
          && candidate.kwp === entry.kwp
          && candidate.tilt === entry.tilt
          && candidate.azimuth === entry.azimuth
          && candidate.hourUtc === entry.hourUtc
        );
        const normalized: SolarProxyHourRecord = {...entry, updatedAt};
        if (index >= 0) {
          solarCache[index] = normalized;
        } else {
          solarCache.push(normalized);
        }
      }
    },
    getActiveProviderCooldown: (provider: string, scope: string, nowIso: string) => {
      const record = cooldowns.get(`${provider}:${scope}`) ?? null;
      if (!record || record.cooldownUntil <= nowIso) {
        return null;
      }
      return record;
    },
    upsertProviderCooldown: (entry: {
      provider: string;
      scope: string;
      cooldownUntil: string;
      reason: string;
    }) => {
      cooldowns.set(`${entry.provider}:${entry.scope}`, {
        provider: entry.provider,
        scope: entry.scope,
        cooldownUntil: entry.cooldownUntil,
        reason: entry.reason,
        updatedAt: new Date().toISOString(),
      });
    },
  } as unknown as StorageService;
}

function nextUtcHour(offsetHours: number): Date {
  const date = new Date(Date.now() + offsetHours * 3_600_000);
  date.setUTCMinutes(0, 0, 0);
  return date;
}

describe("WeatherService", () => {
  beforeEach(() => {
    resetOpenMeteoLocalRateLimitForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to cached solar proxy rows when Open-Meteo responds with 429", async () => {
    const start = nextUtcHour(1);
    const end = nextUtcHour(2);
    const array: SolarArrayConfig = {
      latitude: 48.235,
      longitude: 16.134,
      kwp: 10,
      tilt: 15,
      azimuth: 180,
      timezone: "Europe/Vienna",
    };
    const storage = createStorageStub({
      solar: [{
        latitude: array.latitude,
        longitude: array.longitude,
        kwp: array.kwp,
        tilt: array.tilt,
        azimuth: array.azimuth,
        hourUtc: start.toISOString(),
        globalTiltedIrradiance: 500,
        expectedPowerW: 2500,
        source: "forecast",
        updatedAt: "2026-04-08T00:00:00.000Z",
      }],
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", {status: 429, statusText: "Too Many Requests"}));
    vi.stubGlobal("fetch", fetchMock);

    const service = new WeatherService(storage);
    const result = await service.getSolarProxyHours([array], start, end);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]?.hourUtc).toBe(start.toISOString());
    expect(result[0]?.expectedPowerW).toBe(2500);
  });

  it("falls back to cached weather rows when Open-Meteo is temporarily unavailable", async () => {
    const start = nextUtcHour(1);
    const end = nextUtcHour(2);
    const location: WeatherLocation = {
      latitude: 48.235,
      longitude: 16.134,
      timezone: "Europe/Vienna",
    };
    const storage = createStorageStub({
      weather: [{
        latitude: location.latitude,
        longitude: location.longitude,
        hourUtc: start.toISOString(),
        temperature2m: 12,
        cloudCover: 50,
        windSpeed10m: 8,
        precipitationMm: 0,
        source: "forecast",
        updatedAt: "2026-04-08T00:00:00.000Z",
      }],
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", {status: 429, statusText: "Too Many Requests"}));
    vi.stubGlobal("fetch", fetchMock);

    const service = new WeatherService(storage);
    const result = await service.getWeatherHours(location, start, end);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect(result[0]?.temperature2m).toBe(12);
  });

  it("enforces a local 10x safety margin before issuing more Open-Meteo requests", async () => {
    const array: SolarArrayConfig = {
      latitude: 48.235,
      longitude: 16.134,
      kwp: 10,
      tilt: 15,
      azimuth: 180,
      timezone: "Europe/Vienna",
    };
    const storage = createStorageStub();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      hourly: {
        time: [],
        global_tilted_irradiance: [],
      },
    }), {status: 200, headers: {"content-type": "application/json"}}));
    vi.stubGlobal("fetch", fetchMock);

    const service = new WeatherService(storage);
    let localLimitErrors = 0;

    for (let index = 0; index < 61; index += 1) {
      const start = nextUtcHour(index + 1);
      const end = nextUtcHour(index + 1);
      try {
        await service.getSolarProxyHours([array], start, end);
      } catch (error) {
        if (String(error).includes("local safety limit")) {
          localLimitErrors += 1;
        }
      }
    }

    expect(fetchMock).toHaveBeenCalledTimes(60);
    expect(localLimitErrors).toBe(1);
  });

  it("persists an Open-Meteo cooldown so later service instances skip repeated fetches", async () => {
    const start = nextUtcHour(1);
    const end = nextUtcHour(2);
    const array: SolarArrayConfig = {
      latitude: 48.235,
      longitude: 16.134,
      kwp: 10,
      tilt: 15,
      azimuth: 180,
      timezone: "Europe/Vienna",
    };
    const storage = createStorageStub({
      solar: [{
        latitude: array.latitude,
        longitude: array.longitude,
        kwp: array.kwp,
        tilt: array.tilt,
        azimuth: array.azimuth,
        hourUtc: start.toISOString(),
        globalTiltedIrradiance: 500,
        expectedPowerW: 2500,
        source: "forecast",
        updatedAt: "2026-04-08T00:00:00.000Z",
      }],
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response("", {status: 429, statusText: "Too Many Requests"}));
    vi.stubGlobal("fetch", fetchMock);

    const firstService = new WeatherService(storage);
    const first = await firstService.getSolarProxyHours([array], start, end);
    const secondService = new WeatherService(storage);
    const second = await secondService.getSolarProxyHours([array], start, end);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
