import { Inject, Injectable, Logger } from "@nestjs/common";
import type { HistoryPoint, RawSolarEntry } from "@chargecaster/domain";

import type { ConfigDocument } from "./schemas";
import { WeatherService, type SolarArrayConfig } from "./weather.service";
import { StorageService } from "../storage/storage.service";
import { parseTimestamp } from "../simulation/solar";

const MIN_PROXY_SOLAR_W = 150;
const MIN_CALIBRATION_SAMPLES = 12;
const DEFAULT_RATIO = 1;

interface AggregatedSolarHour {
  hourUtc: string;
  localHour: number;
  season: number;
  measuredSolarW: number;
}

interface SolarCalibrationProfile {
  globalRatio: number;
  hourRatio: Map<number, number>;
  seasonHourRatio: Map<string, number>;
  recentBiasW: number;
  sampleCount: number;
}

@Injectable()
export class SolarForecastCalibrationService {
  private readonly logger = new Logger(SolarForecastCalibrationService.name);

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(WeatherService) private readonly weatherService: WeatherService,
  ) {}

  async calibrateForecast(config: ConfigDocument, solarForecast: RawSolarEntry[]): Promise<RawSolarEntry[]> {
    const normalizedArrays = normalizeSolarArrays(config);
    if (!normalizedArrays.length || !solarForecast.length) {
      return solarForecast;
    }

    const windows = solarForecast
      .map((entry) => toSolarWindow(entry))
      .filter((entry): entry is { start: Date; end: Date; durationHours: number } => entry !== null)
      .sort((left, right) => left.start.getTime() - right.start.getTime());
    if (!windows.length) {
      return solarForecast;
    }

    try {
      const timeZone = resolveTimeZone(config.location?.timezone);
      const profile = await this.buildCalibrationProfile(config, normalizedArrays, timeZone);
      const proxyRows = await this.weatherService.getSolarProxyHours(
        normalizedArrays,
        windows[0].start,
        windows[windows.length - 1].start,
      );
      const proxyPowerByHour = aggregateProxyPowerByHour(proxyRows);
      const confidence = clamp(profile?.sampleCount ?? 0 / 48, 0, 1);

      return solarForecast.map((entry) => {
        const window = toSolarWindow(entry);
        if (!window) {
          return entry;
        }
        const startHourIso = floorToUtcHour(window.start).toISOString();
        const rawPowerW = solarEntryAveragePower(entry, window.durationHours);
        const proxyPowerW = proxyPowerByHour.get(startHourIso) ?? rawPowerW ?? 0;
        const localParts = toTemporalParts(window.start, timeZone);
        const ratio = profile
          ? deriveCalibrationRatio(profile, localParts.localHour, localParts.season)
          : DEFAULT_RATIO;
        const calibratedProxyW = clamp(
          proxyPowerW * ratio + (profile?.recentBiasW ?? 0) * 0.25,
          0,
          Math.max(rawPowerW ?? 0, proxyPowerW * 1.25, 50),
        );

        const rawWeight = rawPowerW == null ? 0 : clamp(0.35 - confidence * 0.15, 0.15, 0.35);
        const finalPowerW = rawPowerW == null
          ? calibratedProxyW
          : clamp(calibratedProxyW * (1 - rawWeight) + rawPowerW * rawWeight, 0, Math.max(calibratedProxyW, rawPowerW, 50));

        const energyWh = finalPowerW * window.durationHours;
        return {
          ...entry,
          start: window.start.toISOString(),
          end: window.end.toISOString(),
          ts: window.start.toISOString(),
          energy_wh: roundNumber(energyWh, 3),
          energy_kwh: roundNumber(energyWh / 1000, 6),
          calibrated_power_w: roundNumber(finalPowerW, 3),
          raw_power_w: rawPowerW != null ? roundNumber(rawPowerW, 3) : undefined,
          proxy_power_w: roundNumber(proxyPowerW, 3),
          calibration_ratio: roundNumber(ratio, 6),
          calibration_confidence: roundNumber(confidence, 6),
        } satisfies RawSolarEntry;
      });
    } catch (error) {
      this.logger.warn(`Solar forecast calibration failed; using raw forecast: ${String(error)}`);
      return solarForecast;
    }
  }

  private async buildCalibrationProfile(
    config: ConfigDocument,
    arrays: SolarArrayConfig[],
    timeZone: string,
  ): Promise<SolarCalibrationProfile | null> {
    const history = this.storage.listAllHistoryAsc().map((record) => record.payload);
    const aggregatedHistory = aggregateMeasuredSolarByHour(history, timeZone);
    if (!aggregatedHistory.length) {
      return null;
    }

    const proxyRows = await this.weatherService.getSolarProxyHours(
      arrays,
      new Date(aggregatedHistory[0].hourUtc),
      new Date(aggregatedHistory[aggregatedHistory.length - 1].hourUtc),
    );
    const proxyPowerByHour = aggregateProxyPowerByHour(proxyRows);
    const nowMs = Date.now();
    const samples = aggregatedHistory
      .map((hour) => {
        const proxyPowerW = proxyPowerByHour.get(hour.hourUtc) ?? 0;
        if (proxyPowerW < MIN_PROXY_SOLAR_W) {
          return null;
        }
        const ageDays = Math.max(0, (nowMs - new Date(hour.hourUtc).getTime()) / 86_400_000);
        return {
          ...hour,
          proxyPowerW,
          ratio: clamp(hour.measuredSolarW / proxyPowerW, 0.05, 1.25),
          weight: Math.exp(-ageDays / 45),
        };
      })
      .filter((sample): sample is NonNullable<typeof sample> => sample !== null);

    if (samples.length < MIN_CALIBRATION_SAMPLES) {
      return null;
    }

    const globalRatio = weightedAverageRatio(samples);
    const hourRatio = new Map<number, number>();
    for (let hour = 0; hour < 24; hour += 1) {
      const subset = samples.filter((sample) => sample.localHour === hour);
      if (subset.length >= 2) {
        hourRatio.set(hour, weightedAverageRatio(subset));
      }
    }

    const seasonHourRatio = new Map<string, number>();
    for (const sample of samples) {
      const key = `${sample.season}:${sample.localHour}`;
      const existing = seasonHourRatio.get(key);
      if (existing != null) {
        continue;
      }
      const subset = samples.filter((candidate) => candidate.season === sample.season && candidate.localHour === sample.localHour);
      if (subset.length >= 2) {
        seasonHourRatio.set(key, weightedAverageRatio(subset));
      }
    }

    const recentSunny = samples.slice(-6);
    const recentBiasW = recentSunny.length
      ? recentSunny.reduce((sum, sample) => {
        const baselineRatio = seasonHourRatio.get(`${sample.season}:${sample.localHour}`)
          ?? hourRatio.get(sample.localHour)
          ?? globalRatio;
        return sum + (sample.measuredSolarW - sample.proxyPowerW * baselineRatio);
      }, 0) / recentSunny.length
      : 0;

    return {
      globalRatio,
      hourRatio,
      seasonHourRatio,
      recentBiasW,
      sampleCount: samples.length,
    };
  }
}

function normalizeSolarArrays(config: ConfigDocument): SolarArrayConfig[] {
  const latitude = config.location?.latitude ?? Number.NaN;
  const longitude = config.location?.longitude ?? Number.NaN;
  const timeZone = resolveTimeZone(config.location?.timezone);
  return (config.solar ?? [])
    .map((entry) => ({
      latitude,
      longitude,
      kwp: entry.kwp ?? Number.NaN,
      tilt: entry.dec ?? Number.NaN,
      azimuth: entry.az ?? Number.NaN,
      timezone: timeZone,
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

function aggregateMeasuredSolarByHour(history: HistoryPoint[], timeZone: string): AggregatedSolarHour[] {
  const grouped = new Map<string, { solarSum: number; solarCount: number }>();
  for (const point of history) {
    const timestamp = parseTimestamp(point.timestamp);
    const solarPowerW = point.solar_power_w;
    if (!timestamp || typeof solarPowerW !== "number" || !Number.isFinite(solarPowerW)) {
      continue;
    }
    const hourUtc = floorToUtcHour(timestamp).toISOString();
    const bucket = grouped.get(hourUtc) ?? { solarSum: 0, solarCount: 0 };
    bucket.solarSum += Math.max(0, solarPowerW);
    bucket.solarCount += 1;
    grouped.set(hourUtc, bucket);
  }

  return [...grouped.entries()]
    .filter(([, bucket]) => bucket.solarCount >= 6)
    .map(([hourUtc, bucket]) => {
      const localParts = toTemporalParts(new Date(hourUtc), timeZone);
      return {
        hourUtc,
        localHour: localParts.localHour,
        season: localParts.season,
        measuredSolarW: bucket.solarSum / bucket.solarCount,
      };
    })
    .sort((left, right) => left.hourUtc.localeCompare(right.hourUtc));
}

function aggregateProxyPowerByHour(rows: Array<{ hourUtc: string; expectedPowerW: number | null }>): Map<string, number> {
  const result = new Map<string, number>();
  for (const row of rows) {
    const expectedPowerW = row.expectedPowerW ?? 0;
    result.set(row.hourUtc, (result.get(row.hourUtc) ?? 0) + expectedPowerW);
  }
  return result;
}

function deriveCalibrationRatio(profile: SolarCalibrationProfile, localHour: number, season: number): number {
  const values: number[] = [];
  const weights: number[] = [];
  const seasonHour = profile.seasonHourRatio.get(`${season}:${localHour}`);
  if (seasonHour != null) {
    values.push(seasonHour);
    weights.push(0.55);
  }
  const hour = profile.hourRatio.get(localHour);
  if (hour != null) {
    values.push(hour);
    weights.push(0.25);
  }
  values.push(profile.globalRatio);
  weights.push(0.2);
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  const blended = values.reduce((sum, value, index) => sum + value * weights[index], 0) / (weightSum || 1);
  return clamp(blended, 0.1, 1.2);
}

function weightedAverageRatio(samples: Array<{ ratio: number; weight: number }>): number {
  const weighted = samples.reduce((sum, sample) => sum + sample.ratio * sample.weight, 0);
  const totalWeight = samples.reduce((sum, sample) => sum + sample.weight, 0);
  return totalWeight > 0 ? weighted / totalWeight : DEFAULT_RATIO;
}

function toSolarWindow(entry: RawSolarEntry): { start: Date; end: Date; durationHours: number } | null {
  const start = parseTimestamp(entry.start ?? entry.ts ?? null);
  if (!start) {
    return null;
  }
  const end = parseTimestamp(entry.end ?? null) ?? new Date(start.getTime() + 3_600_000);
  if (end.getTime() <= start.getTime()) {
    return null;
  }
  return {
    start,
    end,
    durationHours: (end.getTime() - start.getTime()) / 3_600_000,
  };
}

function solarEntryAveragePower(entry: RawSolarEntry, durationHours: number): number | null {
  if (durationHours <= 0) {
    return null;
  }
  if (typeof entry.energy_wh === "number" && Number.isFinite(entry.energy_wh)) {
    return entry.energy_wh / durationHours;
  }
  if (typeof entry.energy_kwh === "number" && Number.isFinite(entry.energy_kwh)) {
    return entry.energy_kwh * 1000 / durationHours;
  }
  const hintedPower = typeof entry.calibrated_power_w === "number" && Number.isFinite(entry.calibrated_power_w)
    ? entry.calibrated_power_w
    : typeof entry.value === "number" && Number.isFinite(entry.value)
      ? entry.value
      : typeof entry.val === "number" && Number.isFinite(entry.val)
        ? entry.val
        : null;
  return hintedPower != null ? Math.max(0, hintedPower) : null;
}

function floorToUtcHour(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCMinutes(0, 0, 0);
  return copy;
}

function toTemporalParts(date: Date, timeZone: string): { localHour: number; season: number } {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    hourCycle: "h23",
    month: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "1");
  return {
    localHour: hour,
    season: seasonFromMonth(month),
  };
}

function seasonFromMonth(month: number): number {
  if ([12, 1, 2].includes(month)) {
    return 0;
  }
  if ([3, 4, 5].includes(month)) {
    return 1;
  }
  if ([6, 7, 8].includes(month)) {
    return 2;
  }
  return 3;
}

function resolveTimeZone(value: string | null | undefined): string {
  const candidate = typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
  return candidate || "UTC";
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function roundNumber(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}
