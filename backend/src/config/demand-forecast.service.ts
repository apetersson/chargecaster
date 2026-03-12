import { Inject, Injectable, Logger } from "@nestjs/common";
import type { DemandForecastEntry, ForecastEra, HistoryPoint } from "@chargecaster/domain";
import { extractForecastEraPrice, extractForecastEraSolar, parseTemporal, TimeSlot } from "@chargecaster/domain";
import type { ConfigDocument } from "./schemas";
import { WeatherService, type WeatherLocation } from "./weather.service";
import { StorageService, type WeatherHourRecord } from "../storage/storage.service";

const DEFAULT_HOUSE_LOAD_W = 2200;
const MIN_HOUSE_LOAD_W = 150;
const MAX_HOUSE_LOAD_W = 15000;
const MAX_NEIGHBORS = 24;
const EV_RECENT_WINDOW_HOURS = 2;
const EV_FORECAST_STEPS = [1, 1, 0.75, 0.5, 0.25] as const;

interface HistoricalHour {
  hourUtc: string;
  localHour: number;
  weekday: number;
  month: number;
  season: number;
  homePowerW: number;
  evPowerW: number;
  solarPowerW: number;
  priceEurPerKwh: number;
  temperature2m: number | null;
  cloudCover: number | null;
  windSpeed10m: number | null;
  precipitationMm: number | null;
}

interface ForecastHourContext {
  start: Date;
  end: Date | null;
  hourUtc: string;
  localHour: number;
  weekday: number;
  month: number;
  season: number;
  solarPowerW: number;
  priceEurPerKwh: number;
  temperature2m: number | null;
  cloudCover: number | null;
  windSpeed10m: number | null;
  precipitationMm: number | null;
}

interface BaselineBundle {
  hourWeek: Map<string, number>;
  seasonHour: Map<string, number>;
  hourOnly: Map<number, number>;
}

export interface DemandForecastBuildInput {
  config: ConfigDocument;
  forecastEras: ForecastEra[];
  liveHomePowerW?: number | null;
  liveEvChargePowerW?: number | null;
  evConnected?: boolean;
  evCharging?: boolean;
}

@Injectable()
export class DemandForecastService {
  private readonly logger = new Logger(DemandForecastService.name);

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(WeatherService) private readonly weatherService: WeatherService,
  ) {}

  async buildForecast(input: DemandForecastBuildInput): Promise<DemandForecastEntry[]> {
    if (!Array.isArray(input.forecastEras) || input.forecastEras.length === 0) {
      return [];
    }

    const timeZone = resolveTimeZone(input.config.location?.timezone);
    const futureContexts = input.forecastEras
      .map((era) => toForecastContext(era, timeZone))
      .filter((context): context is ForecastHourContext => context !== null)
      .sort((left, right) => left.start.getTime() - right.start.getTime());

    if (!futureContexts.length) {
      return [];
    }

    const historyPoints = this.storage.listAllHistoryAsc().map((record) => record.payload);
    const location = resolveWeatherLocation(input.config, timeZone);
    const futureWeatherByHour = location
      ? await this.loadWeatherMap(location, futureContexts[0].hourUtc, futureContexts[futureContexts.length - 1].hourUtc)
      : new Map<string, WeatherHourRecord>();
    for (const context of futureContexts) {
      const weather = futureWeatherByHour.get(context.hourUtc);
      if (!weather) {
        continue;
      }
      context.temperature2m = weather.temperature2m;
      context.cloudCover = weather.cloudCover;
      context.windSpeed10m = weather.windSpeed10m;
      context.precipitationMm = weather.precipitationMm;
    }

    const historicalHours = await this.buildHistoricalHours(historyPoints, timeZone, location);
    const baselines = buildBaselines(historicalHours);
    const recentHomes = historicalHours.slice(-3).map((row) => row.homePowerW);
    const recentBias = computeRecentBias(historicalHours, baselines);
    const evForecast = buildEvForecast({
      contexts: futureContexts,
      historicalHours,
      liveEvChargePowerW: input.liveEvChargePowerW ?? null,
      evConnected: input.evConnected ?? false,
      evCharging: input.evCharging ?? false,
    });

    const forecast: DemandForecastEntry[] = [];
    const rollingHomes = recentHomes.length ? [...recentHomes] : [DEFAULT_HOUSE_LOAD_W];

    for (let index = 0; index < futureContexts.length; index += 1) {
      const context = futureContexts[index];
      const baselineHousePowerW = predictBaselineHousePower(context, baselines);
      const lag1 = rollingHomes.at(-1) ?? baselineHousePowerW;
      const lag3 = average(rollingHomes.slice(-3)) ?? lag1;
      const neighborResult = predictFromNeighbors(historicalHours, context, lag1, lag3);
      let housePowerW =
        baselineHousePowerW * 0.5 +
        neighborResult.value * 0.35 +
        lag3 * 0.15 +
        recentBias * 0.4;
      if (index === 0 && typeof input.liveHomePowerW === "number" && Number.isFinite(input.liveHomePowerW)) {
        housePowerW = housePowerW * 0.55 + input.liveHomePowerW * 0.45;
      }
      housePowerW = clamp(housePowerW, MIN_HOUSE_LOAD_W, MAX_HOUSE_LOAD_W);

      const directPvUseW = clamp(
        Math.min(housePowerW, context.solarPowerW),
        0,
        Math.max(housePowerW, 0),
      );
      const residualHousePowerW = clamp(housePowerW - directPvUseW, 0, MAX_HOUSE_LOAD_W);
      const evPowerW = evForecast[index] ?? 0;
      const totalPowerW = housePowerW + evPowerW;
      const confidence = clamp(
        0.3 + neighborResult.confidence * 0.45 + (historicalHours.length >= 24 ? 0.2 : 0) + (index < 2 ? 0.05 : 0),
        0,
        1,
      );

      forecast.push({
        start: context.start.toISOString(),
        end: context.end?.toISOString(),
        house_power_w: roundNumber(housePowerW, 3),
        direct_pv_use_w: roundNumber(directPvUseW, 3),
        residual_house_power_w: roundNumber(residualHousePowerW, 3),
        ev_power_w: roundNumber(evPowerW, 3),
        total_power_w: roundNumber(totalPowerW, 3),
        baseline_house_power_w: roundNumber(baselineHousePowerW, 3),
        confidence: roundNumber(confidence, 6),
        source: historicalHours.length > 0 ? "hybrid_history_weather" : "cold_start",
      });

      rollingHomes.push(housePowerW);
      while (rollingHomes.length > 6) {
        rollingHomes.shift();
      }
    }

    this.logger.log(`Built ${forecast.length} demand forecast entries`);
    return forecast;
  }

  private async buildHistoricalHours(
    historyPoints: HistoryPoint[],
    timeZone: string,
    location: WeatherLocation | null,
  ): Promise<HistoricalHour[]> {
    const grouped = aggregateHistoryByHour(historyPoints);
    if (!grouped.length) {
      return [];
    }

    const weatherByHour = location
      ? await this.loadWeatherMap(location, grouped[0].hourUtc, grouped[grouped.length - 1].hourUtc)
      : new Map<string, WeatherHourRecord>();

    return grouped.map((entry) => {
      const local = toTemporalParts(new Date(entry.hourUtc), timeZone);
      const weather = weatherByHour.get(entry.hourUtc);
      return {
        hourUtc: entry.hourUtc,
        localHour: local.hour,
        weekday: local.weekday,
        month: local.month,
        season: seasonFromMonth(local.month),
        homePowerW: entry.homePowerW,
        evPowerW: entry.evPowerW,
        solarPowerW: entry.solarPowerW,
        priceEurPerKwh: entry.priceEurPerKwh,
        temperature2m: weather?.temperature2m ?? null,
        cloudCover: weather?.cloudCover ?? null,
        windSpeed10m: weather?.windSpeed10m ?? null,
        precipitationMm: weather?.precipitationMm ?? null,
      };
    });
  }

  private async loadWeatherMap(
    location: WeatherLocation,
    startIso: string,
    endIso: string,
  ): Promise<Map<string, WeatherHourRecord>> {
    const hours = await this.weatherService.getWeatherHours(location, new Date(startIso), new Date(endIso));
    const map = new Map<string, WeatherHourRecord>();
    for (const entry of hours) {
      map.set(entry.hourUtc, entry);
    }
    return map;
  }
}

function aggregateHistoryByHour(historyPoints: HistoryPoint[]): Array<{
  hourUtc: string;
  homePowerW: number;
  evPowerW: number;
  solarPowerW: number;
  priceEurPerKwh: number;
}> {
  const grouped = new Map<string, {
    homeSum: number;
    homeCount: number;
    evSum: number;
    evCount: number;
    solarSum: number;
    solarCount: number;
    priceSum: number;
    priceCount: number;
  }>();

  for (const point of historyPoints) {
    const timestamp = parseTemporal(point.timestamp);
    if (!timestamp || typeof point.home_power_w !== "number" || !Number.isFinite(point.home_power_w)) {
      continue;
    }
    const hourUtc = floorToUtcHour(timestamp).toISOString();
    const bucket = grouped.get(hourUtc) ?? {
      homeSum: 0,
      homeCount: 0,
      evSum: 0,
      evCount: 0,
      solarSum: 0,
      solarCount: 0,
      priceSum: 0,
      priceCount: 0,
    };
    bucket.homeSum += point.home_power_w;
    bucket.homeCount += 1;
    if (typeof point.ev_charge_power_w === "number" && Number.isFinite(point.ev_charge_power_w)) {
      bucket.evSum += Math.max(0, point.ev_charge_power_w);
      bucket.evCount += 1;
    }
    if (typeof point.solar_power_w === "number" && Number.isFinite(point.solar_power_w)) {
      bucket.solarSum += Math.max(0, point.solar_power_w);
      bucket.solarCount += 1;
    }
    if (typeof point.price_eur_per_kwh === "number" && Number.isFinite(point.price_eur_per_kwh)) {
      bucket.priceSum += point.price_eur_per_kwh;
      bucket.priceCount += 1;
    }
    grouped.set(hourUtc, bucket);
  }

  return [...grouped.entries()]
    .map(([hourUtc, bucket]) => ({
      hourUtc,
      homePowerW: bucket.homeCount > 0 ? bucket.homeSum / bucket.homeCount : DEFAULT_HOUSE_LOAD_W,
      evPowerW: bucket.evCount > 0 ? bucket.evSum / bucket.evCount : 0,
      solarPowerW: bucket.solarCount > 0 ? bucket.solarSum / bucket.solarCount : 0,
      priceEurPerKwh: bucket.priceCount > 0 ? bucket.priceSum / bucket.priceCount : 0,
    }))
    .sort((left, right) => left.hourUtc.localeCompare(right.hourUtc));
}

function buildBaselines(rows: HistoricalHour[]): BaselineBundle {
  const nowMs = Date.now();
  const hourWeek = buildWeightedAverageMap(rows, (row) => `${row.weekday}:${row.localHour}`, nowMs);
  const seasonHour = buildWeightedAverageMap(rows, (row) => `${row.season}:${row.localHour}`, nowMs);
  const hourOnly = new Map<number, number>();
  for (let hour = 0; hour < 24; hour += 1) {
    const subset = rows.filter((row) => row.localHour === hour);
    if (subset.length) {
      hourOnly.set(hour, weightedAverage(subset, nowMs));
    }
  }
  return { hourWeek, seasonHour, hourOnly };
}

function buildWeightedAverageMap(
  rows: HistoricalHour[],
  getKey: (row: HistoricalHour) => string,
  nowMs: number,
): Map<string, number> {
  const totals = new Map<string, { weighted: number; weight: number }>();
  for (const row of rows) {
    const key = getKey(row);
    const ageDays = Math.max(0, (nowMs - new Date(row.hourUtc).getTime()) / 86_400_000);
    const weight = Math.exp(-ageDays / 45);
    const current = totals.get(key) ?? { weighted: 0, weight: 0 };
    current.weighted += row.homePowerW * weight;
    current.weight += weight;
    totals.set(key, current);
  }
  const result = new Map<string, number>();
  for (const [key, value] of totals.entries()) {
    if (value.weight > 0) {
      result.set(key, value.weighted / value.weight);
    }
  }
  return result;
}

function predictBaselineHousePower(context: ForecastHourContext, baselines: BaselineBundle): number {
  const hourWeek = baselines.hourWeek.get(`${context.weekday}:${context.localHour}`);
  const seasonHour = baselines.seasonHour.get(`${context.season}:${context.localHour}`);
  const hourOnly = baselines.hourOnly.get(context.localHour);
  if (hourWeek != null && seasonHour != null && hourOnly != null) {
    return hourWeek * 0.55 + seasonHour * 0.25 + hourOnly * 0.2;
  }
  if (hourWeek != null && hourOnly != null) {
    return hourWeek * 0.7 + hourOnly * 0.3;
  }
  if (seasonHour != null && hourOnly != null) {
    return seasonHour * 0.6 + hourOnly * 0.4;
  }
  return hourWeek ?? seasonHour ?? hourOnly ?? DEFAULT_HOUSE_LOAD_W;
}

function predictFromNeighbors(
  rows: HistoricalHour[],
  context: ForecastHourContext,
  lag1: number,
  lag3: number,
): { value: number; confidence: number } {
  if (!rows.length) {
    return { value: DEFAULT_HOUSE_LOAD_W, confidence: 0 };
  }

  const targetMs = context.start.getTime();
  const ranked = rows
    .map((row) => {
      const ageDays = Math.max(0, (targetMs - new Date(row.hourUtc).getTime()) / 86_400_000);
      const hourDistance = circularHourDistance(row.localHour, context.localHour) / 12;
      const weekdayPenalty = row.weekday === context.weekday ? 0 : isWeekend(row.weekday) === isWeekend(context.weekday) ? 0.2 : 0.45;
      const seasonPenalty = row.season === context.season ? 0 : 0.3;
      const temperaturePenalty = normalizedDistance(row.temperature2m, context.temperature2m, 12);
      const cloudPenalty = normalizedDistance(row.cloudCover, context.cloudCover, 60);
      const windPenalty = normalizedDistance(row.windSpeed10m, context.windSpeed10m, 12);
      const precipitationPenalty = normalizedDistance(row.precipitationMm, context.precipitationMm, 3);
      const solarPenalty = normalizedDistance(row.solarPowerW, context.solarPowerW, 2500);
      const pricePenalty = normalizedDistance(row.priceEurPerKwh, context.priceEurPerKwh, 0.12);
      const lagPenalty = normalizedDistance(row.homePowerW, lag1, 2500) * 0.3 + normalizedDistance(row.homePowerW, lag3, 2500) * 0.2;
      const distance = hourDistance + weekdayPenalty + seasonPenalty + temperaturePenalty + cloudPenalty +
        windPenalty + precipitationPenalty + solarPenalty + pricePenalty + lagPenalty;
      const recencyWeight = Math.exp(-ageDays / 75);
      const weight = recencyWeight / (1 + distance);
      return { row, weight };
    })
    .sort((left, right) => right.weight - left.weight)
    .slice(0, MAX_NEIGHBORS)
    .filter((entry) => entry.weight > 0);

  const totalWeight = ranked.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight <= 0) {
    return { value: DEFAULT_HOUSE_LOAD_W, confidence: 0 };
  }
  const value = ranked.reduce((sum, entry) => sum + entry.row.homePowerW * entry.weight, 0) / totalWeight;
  const confidence = clamp(totalWeight / 6, 0, 1);
  return { value, confidence };
}

function computeRecentBias(rows: HistoricalHour[], baselines: BaselineBundle): number {
  const recent = rows.slice(-3);
  if (!recent.length) {
    return 0;
  }
  const deltas = recent.map((row) => row.homePowerW - predictBaselineHousePower({
    start: new Date(row.hourUtc),
    end: null,
    hourUtc: row.hourUtc,
    localHour: row.localHour,
    weekday: row.weekday,
    month: row.month,
    season: row.season,
    solarPowerW: row.solarPowerW,
    priceEurPerKwh: row.priceEurPerKwh,
    temperature2m: row.temperature2m,
    cloudCover: row.cloudCover,
    windSpeed10m: row.windSpeed10m,
    precipitationMm: row.precipitationMm,
  }, baselines));
  return average(deltas) ?? 0;
}

function buildEvForecast(input: {
  contexts: ForecastHourContext[];
  historicalHours: HistoricalHour[];
  liveEvChargePowerW: number | null;
  evConnected: boolean;
  evCharging: boolean;
}): number[] {
  const latestHistory = input.historicalHours.at(-1) ?? null;
  const recentActive = input.historicalHours
    .slice(-EV_RECENT_WINDOW_HOURS)
    .some((entry) => entry.evPowerW > 0);
  const shouldForecast = input.evCharging || input.evConnected || recentActive;
  if (!shouldForecast || input.contexts.length === 0) {
    return input.contexts.map(() => 0);
  }

  const recentEvValues = input.historicalHours
    .slice(-6)
    .map((entry) => entry.evPowerW)
    .filter((value) => value > 0)
    .sort((left, right) => left - right);
  const medianRecentEv = recentEvValues.length
    ? recentEvValues[Math.floor(recentEvValues.length / 2)]
    : latestHistory?.evPowerW ?? 0;
  const anchor = Math.max(0, input.liveEvChargePowerW ?? medianRecentEv ?? 0);
  if (!(anchor > 0)) {
    return input.contexts.map(() => 0);
  }

  return input.contexts.map((_, index) => {
    const factor = EV_FORECAST_STEPS[Math.min(index, EV_FORECAST_STEPS.length - 1)] ?? 0;
    return roundNumber(anchor * factor, 3);
  });
}

function toForecastContext(era: ForecastEra, timeZone: string): ForecastHourContext | null {
  const start = parseTemporal(era.start);
  if (!start) {
    return null;
  }
  const end = parseTemporal(era.end);
  const slot = (() => {
    try {
      return TimeSlot.fromDates(start, end ?? new Date(start.getTime() + 3_600_000));
    } catch {
      return null;
    }
  })();
  if (!slot) {
    return null;
  }
  const local = toTemporalParts(start, timeZone);
  const solar = extractForecastEraSolar(era, slot);
  const price = extractForecastEraPrice(era);
  return {
    start,
    end,
    hourUtc: floorToUtcHour(start).toISOString(),
    localHour: local.hour,
    weekday: local.weekday,
    month: local.month,
    season: seasonFromMonth(local.month),
    solarPowerW: solar.averagePower?.watts ?? 0,
    priceEurPerKwh: price?.eurPerKwh ?? 0,
    temperature2m: null,
    cloudCover: null,
    windSpeed10m: null,
    precipitationMm: null,
  };
}

function resolveWeatherLocation(config: ConfigDocument, defaultTimeZone: string): WeatherLocation | null {
  const latitude = config.location?.latitude;
  const longitude = config.location?.longitude;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || typeof longitude !== "number" || !Number.isFinite(longitude)) {
    return null;
  }
  return {
    latitude,
    longitude,
    timezone: resolveTimeZone(config.location?.timezone ?? defaultTimeZone),
  };
}

function resolveTimeZone(value: string | null | undefined): string {
  const candidate = typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
  return candidate || "UTC";
}

function toTemporalParts(date: Date, timeZone: string): { weekday: number; hour: number; month: number } {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
    month: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const weekdayLabel = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "1");
  return {
    weekday: weekdayLabelToIndex(weekdayLabel),
    hour,
    month,
  };
}

function weekdayLabelToIndex(value: string): number {
  switch (value.slice(0, 3).toLowerCase()) {
    case "sun":
      return 0;
    case "mon":
      return 1;
    case "tue":
      return 2;
    case "wed":
      return 3;
    case "thu":
      return 4;
    case "fri":
      return 5;
    case "sat":
      return 6;
    default:
      return 1;
  }
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

function weightedAverage(rows: HistoricalHour[], nowMs: number): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const row of rows) {
    const ageDays = Math.max(0, (nowMs - new Date(row.hourUtc).getTime()) / 86_400_000);
    const weight = Math.exp(-ageDays / 45);
    weightedSum += row.homePowerW * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : DEFAULT_HOUSE_LOAD_W;
}

function normalizedDistance(left: number | null, right: number | null, scale: number): number {
  if (left == null || right == null || !Number.isFinite(left) || !Number.isFinite(right) || scale <= 0) {
    return 0.15;
  }
  return Math.min(2, Math.abs(left - right) / scale);
}

function circularHourDistance(left: number, right: number): number {
  const delta = Math.abs(left - right);
  return Math.min(delta, 24 - delta);
}

function isWeekend(weekday: number): boolean {
  return weekday === 0 || weekday === 6;
}

function average(values: number[]): number | null {
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundNumber(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function floorToUtcHour(date: Date): Date {
  const result = new Date(date);
  result.setUTCMinutes(0, 0, 0);
  return result;
}
