import { Inject, Injectable, Logger } from "@nestjs/common";
import { Energy, Power } from "@chargecaster/domain";
import type { RawSolarEntry } from "@chargecaster/domain";

import { resolveEnergyPriceConfig, type ConfigDocument } from "./schemas";
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
      const powerByHour = new Map<string, Power>();
      for (const row of rows) {
        const expectedPower = Power.fromWatts(Math.max(0, row.expectedPowerW ?? 0));
        powerByHour.set(row.hourUtc, (powerByHour.get(row.hourUtc) ?? Power.zero()).add(expectedPower));
      }

      const result = [...powerByHour.entries()]
        .sort((left, right) => left[0].localeCompare(right[0]))
        .map(([hourUtc, expectedPower]) => {
          const expectedEnergy = Energy.fromWattHours(expectedPower.watts);
          return ({
          start: hourUtc,
          end: new Date(new Date(hourUtc).getTime() + 3_600_000).toISOString(),
          ts: hourUtc,
          energy_wh: roundNumber(expectedEnergy.wattHours, 3),
          energy_kwh: roundNumber(expectedEnergy.kilowattHours, 6),
          average_power_w: roundNumber(expectedPower.watts, 3),
          provider: "open_meteo",
        }) satisfies RawSolarEntry;
        })
        .filter((entry) => entry.energy_wh > 0);

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
  const energyConfig = resolveEnergyPriceConfig(config);
  const configured = [
    energyConfig?.awattar?.max_hours,
    energyConfig?.entsoe?.max_hours,
    energyConfig?.synthetic?.max_hours,
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
