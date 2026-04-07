import { Inject, Injectable, Logger } from "@nestjs/common";
import { StorageService, type SolarProxyHourRecord, type WeatherHourRecord } from "../storage/storage.service";

const FORECAST_API_URL = "https://api.open-meteo.com/v1/forecast";
const HISTORICAL_FORECAST_API_URL = "https://historical-forecast-api.open-meteo.com/v1/forecast";
const HOURLY_FIELDS = ["temperature_2m", "cloud_cover", "wind_speed_10m", "precipitation"] as const;
const SOLAR_HOURLY_FIELDS = ["global_tilted_irradiance"] as const;
const OPEN_METEO_LOCAL_RATE_LIMITS = [
  {windowMs: 60_000, maxRequests: 60, label: "minute"},
  {windowMs: 3_600_000, maxRequests: 500, label: "hour"},
  {windowMs: 86_400_000, maxRequests: 1000, label: "day"},
  {windowMs: 30 * 86_400_000, maxRequests: 30_000, label: "30d"},
] as const;
const OPEN_METEO_PROVIDER = "open-meteo";
const OPEN_METEO_GLOBAL_SCOPE = "global";
const UPSTREAM_RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
const LOCAL_SAFETY_LIMIT_COOLDOWN_MS = 10 * 60_000;

export interface WeatherLocation {
  latitude: number;
  longitude: number;
  timezone: string;
}

export interface SolarArrayConfig {
  latitude: number;
  longitude: number;
  kwp: number;
  tilt: number;
  azimuth: number;
  timezone: string;
}

interface OpenMeteoPayload {
  hourly?: {
    time?: string[];
    temperature_2m?: (number | null)[];
    cloud_cover?: (number | null)[];
    wind_speed_10m?: (number | null)[];
    precipitation?: (number | null)[];
    global_tilted_irradiance?: (number | null)[];
  };
}

class OpenMeteoLocalRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenMeteoLocalRateLimitError";
  }
}

class OpenMeteoCooldownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenMeteoCooldownError";
  }
}

@Injectable()
export class WeatherService {
  private readonly logger = new Logger(WeatherService.name);
  private static requestTimestampsMs: number[] = [];

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  async getWeatherHours(
    location: WeatherLocation,
    startInclusive: Date,
    endInclusive: Date,
  ): Promise<WeatherHourRecord[]> {
    const startHour = floorToUtcHour(startInclusive);
    const endHour = floorToUtcHour(endInclusive);
    if (endHour.getTime() < startHour.getTime()) {
      return [];
    }

    const startIso = startHour.toISOString();
    const endIso = endHour.toISOString();
    const cached = this.storage.listWeatherHours(location.latitude, location.longitude, startIso, endIso);
    const expectedHours = enumerateHourIsos(startHour, endHour);
    if (cached.length >= expectedHours.length) {
      return cached;
    }

    try {
      const nowHour = floorToUtcHour(new Date());
      if (startHour.getTime() <= nowHour.getTime()) {
        const historicalEnd = new Date(Math.min(endHour.getTime(), nowHour.getTime()));
        await this.fetchAndCacheRange(location, startHour, historicalEnd, HISTORICAL_FORECAST_API_URL, "historical");
      }
      if (endHour.getTime() > nowHour.getTime()) {
        const forecastStart = new Date(Math.max(startHour.getTime(), nowHour.getTime()));
        await this.fetchAndCacheRange(location, forecastStart, endHour, FORECAST_API_URL, "forecast");
      }
    } catch (error) {
      const fallback = this.storage.listWeatherHours(location.latitude, location.longitude, startIso, endIso);
      if (fallback.length > 0) {
        this.logger.warn(
          `Open-Meteo weather fetch failed; serving ${fallback.length}/${expectedHours.length} cached rows (${String(error)})`,
        );
        return fallback;
      }
      throw error;
    }

    return this.storage.listWeatherHours(location.latitude, location.longitude, startIso, endIso);
  }

  async getSolarProxyHours(
    arrays: SolarArrayConfig[],
    startInclusive: Date,
    endInclusive: Date,
  ): Promise<SolarProxyHourRecord[]> {
    const startHour = floorToUtcHour(startInclusive);
    const endHour = floorToUtcHour(endInclusive);
    if (endHour.getTime() < startHour.getTime() || arrays.length === 0) {
      return [];
    }

    const expectedHours = enumerateHourIsos(startHour, endHour);
    const nowHour = floorToUtcHour(new Date());
    const failures: string[] = [];

    for (const arrayConfig of arrays) {
      const cached = this.storage.listSolarProxyHours(
        arrayConfig.latitude,
        arrayConfig.longitude,
        arrayConfig.kwp,
        arrayConfig.tilt,
        arrayConfig.azimuth,
        startHour.toISOString(),
        endHour.toISOString(),
      );
      if (cached.length >= expectedHours.length) {
        continue;
      }

      try {
        if (startHour.getTime() <= nowHour.getTime()) {
          const historicalEnd = new Date(Math.min(endHour.getTime(), nowHour.getTime()));
          await this.fetchAndCacheSolarRange(arrayConfig, startHour, historicalEnd, HISTORICAL_FORECAST_API_URL, "historical");
        }
        if (endHour.getTime() > nowHour.getTime()) {
          const forecastStart = new Date(Math.max(startHour.getTime(), nowHour.getTime()));
          await this.fetchAndCacheSolarRange(arrayConfig, forecastStart, endHour, FORECAST_API_URL, "forecast");
        }
      } catch (error) {
        failures.push(String(error));
        const fallback = this.storage.listSolarProxyHours(
          arrayConfig.latitude,
          arrayConfig.longitude,
          arrayConfig.kwp,
          arrayConfig.tilt,
          arrayConfig.azimuth,
          startHour.toISOString(),
          endHour.toISOString(),
        );
        if (fallback.length > 0) {
          this.logger.warn(
            `Open-Meteo solar proxy fetch failed for tilt=${arrayConfig.tilt} az=${arrayConfig.azimuth}; ` +
            `serving ${fallback.length}/${expectedHours.length} cached rows (${String(error)})`,
          );
          continue;
        }
      }
    }

    const combined = arrays.flatMap((arrayConfig) =>
      this.storage.listSolarProxyHours(
        arrayConfig.latitude,
        arrayConfig.longitude,
        arrayConfig.kwp,
        arrayConfig.tilt,
        arrayConfig.azimuth,
        startHour.toISOString(),
        endHour.toISOString(),
      ),
    );
    if (combined.length === 0 && failures.length > 0) {
      throw new Error(failures[0] ?? "Open-Meteo solar proxy fetch failed.");
    }
    return combined;
  }

  private async fetchAndCacheRange(
    location: WeatherLocation,
    startInclusive: Date,
    endInclusive: Date,
    baseUrl: string,
    source: string,
  ): Promise<void> {
    if (endInclusive.getTime() < startInclusive.getTime()) {
      return;
    }
    const url = new URL(baseUrl);
    url.searchParams.set("latitude", String(location.latitude));
    url.searchParams.set("longitude", String(location.longitude));
    url.searchParams.set("hourly", HOURLY_FIELDS.join(","));
    url.searchParams.set("timezone", "GMT");
    url.searchParams.set("start_date", toDateOnly(startInclusive));
    url.searchParams.set("end_date", toDateOnly(endInclusive));

    this.logger.log(
      `Fetching ${source} weather for ${location.latitude.toFixed(3)},${location.longitude.toFixed(3)} ${toDateOnly(startInclusive)}..${toDateOnly(endInclusive)}`,
    );

    const requestLabel = `${source} weather ${toDateOnly(startInclusive)}..${toDateOnly(endInclusive)}`;
    this.assertNoOpenMeteoCooldown(requestLabel);
    this.consumeOpenMeteoBudget(requestLabel);
    const response = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      if (response.status === 429) {
        this.recordOpenMeteoCooldown(
          requestLabel,
          UPSTREAM_RATE_LIMIT_COOLDOWN_MS,
          `HTTP 429 ${response.statusText || "Too Many Requests"}`,
        );
      }
      throw new Error(`Open-Meteo ${source} weather failed: HTTP ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as OpenMeteoPayload;
    const rows = this.parseHourlyPayload(payload, location, source, startInclusive, endInclusive);
    this.storage.upsertWeatherHours(rows);
  }

  private async fetchAndCacheSolarRange(
    arrayConfig: SolarArrayConfig,
    startInclusive: Date,
    endInclusive: Date,
    baseUrl: string,
    source: string,
  ): Promise<void> {
    if (endInclusive.getTime() < startInclusive.getTime()) {
      return;
    }
    const url = new URL(baseUrl);
    url.searchParams.set("latitude", String(arrayConfig.latitude));
    url.searchParams.set("longitude", String(arrayConfig.longitude));
    url.searchParams.set("hourly", SOLAR_HOURLY_FIELDS.join(","));
    url.searchParams.set("timezone", "GMT");
    url.searchParams.set("start_date", toDateOnly(startInclusive));
    url.searchParams.set("end_date", toDateOnly(endInclusive));
    url.searchParams.set("tilt", String(arrayConfig.tilt));
    url.searchParams.set("azimuth", String(arrayConfig.azimuth));

    this.logger.log(
      `Fetching ${source} solar proxy for ${arrayConfig.latitude.toFixed(3)},${arrayConfig.longitude.toFixed(3)} tilt=${arrayConfig.tilt} az=${arrayConfig.azimuth} ${toDateOnly(startInclusive)}..${toDateOnly(endInclusive)}`,
    );

    const requestLabel = `${source} solar ${toDateOnly(startInclusive)}..${toDateOnly(endInclusive)}`;
    this.assertNoOpenMeteoCooldown(requestLabel);
    this.consumeOpenMeteoBudget(requestLabel);
    const response = await fetch(url, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      if (response.status === 429) {
        this.recordOpenMeteoCooldown(
          requestLabel,
          UPSTREAM_RATE_LIMIT_COOLDOWN_MS,
          `HTTP 429 ${response.statusText || "Too Many Requests"}`,
        );
      }
      throw new Error(`Open-Meteo ${source} solar proxy failed: HTTP ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as OpenMeteoPayload;
    const rows = this.parseSolarProxyPayload(payload, arrayConfig, source, startInclusive, endInclusive);
    this.storage.upsertSolarProxyHours(rows);
  }

  private consumeOpenMeteoBudget(label: string): void {
    const nowMs = Date.now();
    const maxWindowMs = Math.max(...OPEN_METEO_LOCAL_RATE_LIMITS.map((limit) => limit.windowMs));
    WeatherService.requestTimestampsMs = WeatherService.requestTimestampsMs.filter((timestampMs) =>
      nowMs - timestampMs < maxWindowMs,
    );

    for (const limit of OPEN_METEO_LOCAL_RATE_LIMITS) {
      const windowCount = WeatherService.requestTimestampsMs.filter((timestampMs) =>
        nowMs - timestampMs < limit.windowMs,
      ).length;
      if (windowCount >= limit.maxRequests) {
        const message =
          `Open-Meteo local safety limit reached for the ${limit.label} budget ` +
          `(${limit.maxRequests} requests/${limit.label}); skipping ${label}.`;
        this.recordOpenMeteoCooldown(label, LOCAL_SAFETY_LIMIT_COOLDOWN_MS, message);
        throw new OpenMeteoLocalRateLimitError(message);
      }
    }

    WeatherService.requestTimestampsMs.push(nowMs);
  }

  private assertNoOpenMeteoCooldown(label: string): void {
    const active = this.storage.getActiveProviderCooldown(
      OPEN_METEO_PROVIDER,
      OPEN_METEO_GLOBAL_SCOPE,
      new Date().toISOString(),
    );
    if (!active) {
      return;
    }
    throw new OpenMeteoCooldownError(
      `Open-Meteo cooldown active until ${active.cooldownUntil}; skipping ${label}. Reason: ${active.reason}`,
    );
  }

  private recordOpenMeteoCooldown(label: string, durationMs: number, reason: string): void {
    const cooldownUntil = new Date(Date.now() + durationMs).toISOString();
    this.logger.warn(`Applying Open-Meteo cooldown until ${cooldownUntil} after ${label}: ${reason}`);
    this.storage.upsertProviderCooldown({
      provider: OPEN_METEO_PROVIDER,
      scope: OPEN_METEO_GLOBAL_SCOPE,
      cooldownUntil,
      reason,
    });
  }

  private parseHourlyPayload(
    payload: OpenMeteoPayload,
    location: WeatherLocation,
    source: string,
    startInclusive: Date,
    endInclusive: Date,
  ): Omit<WeatherHourRecord, "updatedAt">[] {
    const hourly = payload.hourly;
    const times = Array.isArray(hourly?.time) ? hourly.time : [];
    const temperatures = Array.isArray(hourly?.temperature_2m) ? hourly.temperature_2m : [];
    const cloudCover = Array.isArray(hourly?.cloud_cover) ? hourly.cloud_cover : [];
    const windSpeed = Array.isArray(hourly?.wind_speed_10m) ? hourly.wind_speed_10m : [];
    const precipitation = Array.isArray(hourly?.precipitation) ? hourly.precipitation : [];
    const startMs = floorToUtcHour(startInclusive).getTime();
    const endMs = floorToUtcHour(endInclusive).getTime();

    const rows: Omit<WeatherHourRecord, "updatedAt">[] = [];
    for (let index = 0; index < times.length; index += 1) {
      const hourUtc = normalizeOpenMeteoHour(times[index]);
      if (!hourUtc) {
        continue;
      }
      const hourMs = new Date(hourUtc).getTime();
      if (hourMs < startMs || hourMs > endMs) {
        continue;
      }
      rows.push({
        latitude: location.latitude,
        longitude: location.longitude,
        hourUtc,
        temperature2m: toNullableNumber(temperatures[index]),
        cloudCover: toNullableNumber(cloudCover[index]),
        windSpeed10m: toNullableNumber(windSpeed[index]),
        precipitationMm: toNullableNumber(precipitation[index]),
        source,
      });
    }
    return rows;
  }

  private parseSolarProxyPayload(
    payload: OpenMeteoPayload,
    arrayConfig: SolarArrayConfig,
    source: string,
    startInclusive: Date,
    endInclusive: Date,
  ): Omit<SolarProxyHourRecord, "updatedAt">[] {
    const hourly = payload.hourly;
    const times = Array.isArray(hourly?.time) ? hourly.time : [];
    const irradiance = Array.isArray(hourly?.global_tilted_irradiance) ? hourly.global_tilted_irradiance : [];
    const startMs = floorToUtcHour(startInclusive).getTime();
    const endMs = floorToUtcHour(endInclusive).getTime();
    const rows: Omit<SolarProxyHourRecord, "updatedAt">[] = [];

    for (let index = 0; index < times.length; index += 1) {
      const hourUtc = normalizeOpenMeteoHour(times[index]);
      if (!hourUtc) {
        continue;
      }
      const hourMs = new Date(hourUtc).getTime();
      if (hourMs < startMs || hourMs > endMs) {
        continue;
      }
      const gti = toNullableNumber(irradiance[index]);
      const expectedPowerW = gti == null
        ? null
        : Math.max(0, arrayConfig.kwp * Math.min(gti, 1200));
      rows.push({
        latitude: arrayConfig.latitude,
        longitude: arrayConfig.longitude,
        kwp: arrayConfig.kwp,
        tilt: arrayConfig.tilt,
        azimuth: arrayConfig.azimuth,
        hourUtc,
        globalTiltedIrradiance: gti,
        expectedPowerW,
        source,
      });
    }
    return rows;
  }
}

function floorToUtcHour(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCMinutes(0, 0, 0);
  return copy;
}

function enumerateHourIsos(startInclusive: Date, endInclusive: Date): string[] {
  const hours: string[] = [];
  for (let current = startInclusive.getTime(); current <= endInclusive.getTime(); current += 3_600_000) {
    hours.push(new Date(current).toISOString());
  }
  return hours;
}

function normalizeOpenMeteoHour(value: string | undefined): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  if (value.endsWith("Z")) {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? floorToUtcHour(parsed).toISOString() : null;
  }
  const withZone = /\+\d{2}:\d{2}$/.test(value) ? value : `${value}:00Z`;
  const parsed = new Date(withZone);
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }
  return floorToUtcHour(parsed).toISOString();
}

function toDateOnly(date: Date): string {
  return floorToUtcHour(date).toISOString().slice(0, 10);
}

function toNullableNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function resetOpenMeteoLocalRateLimitForTests(): void {
  WeatherService["requestTimestampsMs"] = [];
}
