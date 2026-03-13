import { Inject, Injectable, Logger } from "@nestjs/common";
import type { RawSolarEntry } from "@chargecaster/domain";

import type { ConfigDocument } from "./schemas";
import { WeatherService, type SolarArrayConfig } from "./weather.service";

const DEFAULT_SOLAR_FORECAST_HOURS = 72;

@Injectable()
export class OpenMeteoSolarForecastService {
  private readonly logger = new Logger(OpenMeteoSolarForecastService.name);

  constructor(
    @Inject(WeatherService) private readonly weatherService: WeatherService,
  ) {}

  async collect(
    config: ConfigDocument,
    warnings: string[],
    now = new Date(),
  ): Promise<RawSolarEntry[]> {
    const arrays = normalizeSolarArrays(config);
    if (!arrays.length) {
      const message = "No solar array config found; skipping Open-Meteo solar forecast.";
      warnings.push(message);
      this.logger.warn(message);
      return [];
    }

    try {
      const start = floorToUtcHour(now);
      const end = new Date(start.getTime() + (resolveSolarForecastHours(config) - 1) * 3_600_000);
      const rows = await this.weatherService.getSolarProxyHours(arrays, start, end);
      const powerByHour = new Map<string, number>();
      for (const row of rows) {
        const expectedPowerW = row.expectedPowerW ?? 0;
        powerByHour.set(row.hourUtc, (powerByHour.get(row.hourUtc) ?? 0) + Math.max(0, expectedPowerW));
      }

      const result = [...powerByHour.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([hourUtc, expectedPowerW]) => ({
          start: hourUtc,
          end: new Date(new Date(hourUtc).getTime() + 3_600_000).toISOString(),
          ts: hourUtc,
          energy_wh: roundNumber(expectedPowerW, 3),
          energy_kwh: roundNumber(expectedPowerW / 1000, 6),
          average_power_w: roundNumber(expectedPowerW, 3),
          provider: "open_meteo",
        }) satisfies RawSolarEntry)
        .filter((entry) => (entry.energy_wh ?? 0) > 0);

      this.logger.log(`Collected ${result.length} Open-Meteo solar forecast slots`);
      return result;
    } catch (error) {
      const message = `Open-Meteo solar forecast failed: ${String(error)}`;
      warnings.push(message);
      this.logger.warn(message);
      return [];
    }
  }
}

function normalizeSolarArrays(config: ConfigDocument): SolarArrayConfig[] {
  const latitude = config.location?.latitude ?? Number.NaN;
  const longitude = config.location?.longitude ?? Number.NaN;
  const timezone = typeof config.location?.timezone === "string" && config.location.timezone.trim().length > 0
    ? config.location.timezone.trim()
    : "UTC";
  return (config.solar ?? [])
    .map((entry) => ({
      latitude,
      longitude,
      kwp: entry.kwp ?? Number.NaN,
      tilt: entry.dec ?? Number.NaN,
      azimuth: entry.az ?? Number.NaN,
      timezone,
    }))
    .filter((entry) =>
      Number.isFinite(entry.latitude) &&
      Number.isFinite(entry.longitude) &&
      Number.isFinite(entry.kwp) &&
      entry.kwp > 0 &&
      Number.isFinite(entry.tilt) &&
      Number.isFinite(entry.azimuth),
    );
}

function resolveSolarForecastHours(config: ConfigDocument): number {
  const configured = [
    config.market_data?.awattar?.max_hours,
    config.market_data?.entsoe?.max_hours,
  ]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0);
  return configured.length ? Math.max(...configured) : DEFAULT_SOLAR_FORECAST_HOURS;
}

function floorToUtcHour(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCMinutes(0, 0, 0);
  return copy;
}

function roundNumber(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}
