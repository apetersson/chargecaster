import { Logger } from "@nestjs/common";
import type { RawForecastEntry } from "@chargecaster/domain";

import type { SyntheticPriceConfig } from "../schemas";
import { WeatherService, type SolarArrayConfig, type WeatherLocation } from "../weather.service";
import { StorageService, type WeatherHourRecord } from "../../storage/storage.service";
import { EnergyPriceProvider, EnergyPriceProviderContext, EnergyPriceProviderResult } from "./provider.types";

const DEFAULT_MAX_HOURS = 120;
const DEFAULT_TOTAL_PRICE_EUR_PER_KWH = 0.22;
const MIN_TOTAL_PRICE_EUR_PER_KWH = 0.04;
const MAX_TOTAL_PRICE_EUR_PER_KWH = 0.65;
const HISTORY_LOOKBACK_DAYS = 180;
const VIENNA_TIME_ZONE = "Europe/Vienna";

interface HistoricalPriceHour {
  hourUtc: string;
  dtUtc: Date;
  localHour: number;
  weekday: number;
  month: number;
  season: number;
  totalPriceEurPerKwh: number;
}

interface FuturePriceContext {
  hourUtc: string;
  dtUtc: Date;
  localHour: number;
  weekday: number;
  month: number;
  season: number;
  solarProxyW: number;
  cloudCover: number | null;
  windSpeed10m: number | null;
  precipitationMm: number | null;
}

interface PriceBaselines {
  hourWeek: Map<string, number>;
  seasonHour: Map<string, number>;
  hourOnly: Map<number, number>;
}

const AUSTRIA_WEATHER_POINTS: WeatherLocation[] = [
  {latitude: 48.2082, longitude: 16.3738, timezone: VIENNA_TIME_ZONE}, // Vienna
  {latitude: 48.3069, longitude: 14.2858, timezone: VIENNA_TIME_ZONE}, // Linz
  {latitude: 47.0707, longitude: 15.4395, timezone: VIENNA_TIME_ZONE}, // Graz
  {latitude: 47.8095, longitude: 13.055, timezone: VIENNA_TIME_ZONE}, // Salzburg
  {latitude: 47.2692, longitude: 11.4041, timezone: VIENNA_TIME_ZONE}, // Innsbruck
  {latitude: 46.6247, longitude: 14.3053, timezone: VIENNA_TIME_ZONE}, // Klagenfurt
];

const AUSTRIA_SOLAR_POINTS: SolarArrayConfig[] = AUSTRIA_WEATHER_POINTS.map((point) => ({
  latitude: point.latitude,
  longitude: point.longitude,
  timezone: point.timezone,
  kwp: 1,
  tilt: 35,
  azimuth: 180,
}));

export class SyntheticPriceProvider implements EnergyPriceProvider {
  readonly key = "synthetic";
  private readonly logger = new Logger(SyntheticPriceProvider.name);

  constructor(
    private readonly storage: StorageService,
    private readonly weatherService: WeatherService,
    private readonly cfg?: SyntheticPriceConfig,
  ) {}

  async collect(ctx: EnergyPriceProviderContext): Promise<EnergyPriceProviderResult> {
    const maxHours = normalizeMaxHours(this.cfg?.max_hours);
    const history = this.buildHistoricalHours();
    if (!history.length) {
      const message = "Synthetic price forecast skipped: no historical price data available.";
      this.logger.warn(message);
      ctx.warnings.push(message);
      return {forecast: [], priceSnapshot: null};
    }

    try {
      const start = ceilToUtcHour(new Date());
      const end = new Date(start.getTime() + Math.max(0, maxHours - 1) * 3_600_000);
      const futureContexts = await this.buildFutureContexts(start, end);
      if (!futureContexts.length) {
        const message = "Synthetic price forecast skipped: weather context unavailable.";
        this.logger.warn(message);
        ctx.warnings.push(message);
        return {forecast: [], priceSnapshot: null};
      }

      const baselines = buildBaselines(history);
      const historyByHour = new Map(history.map((row) => [row.hourUtc, row.totalPriceEurPerKwh]));
      const recentMean = average(history.slice(-24).map((row) => row.totalPriceEurPerKwh)) ?? DEFAULT_TOTAL_PRICE_EUR_PER_KWH;
      const gridFee = ctx.simulationConfig.price.grid_fee_eur_per_kwh ?? 0;
      const forecast: RawForecastEntry[] = [];
      const predictedTotalByHour = new Map<string, number>();
      let previousTotal: number | null = history[history.length - 1]?.totalPriceEurPerKwh ?? null;

      for (const context of futureContexts) {
        const baseline = predictBaselineTotalPrice(context, baselines, recentMean);
        const lag24 = predictedTotalByHour.get(offsetHourIso(context.hourUtc, -24)) ?? historyByHour.get(offsetHourIso(context.hourUtc, -24)) ?? null;
        const lag168 = historyByHour.get(offsetHourIso(context.hourUtc, -168)) ?? null;
        const weatherAdjustment = computeWeatherAdjustment(context);
        const recencyAdjustment = clamp((recentMean - baseline) * 0.18, -0.03, 0.03);

        let totalPrice = baseline * 0.6;
        totalPrice += (lag24 ?? baseline) * (lag24 == null ? 0.0 : 0.22);
        totalPrice += (lag168 ?? baseline) * (lag168 == null ? 0.0 : 0.1);
        totalPrice += (previousTotal ?? baseline) * (previousTotal == null ? 0.0 : 0.08);
        totalPrice += weatherAdjustment + recencyAdjustment;
        if (previousTotal != null) {
          totalPrice = totalPrice * 0.84 + previousTotal * 0.16;
        }
        totalPrice = clamp(totalPrice, MIN_TOTAL_PRICE_EUR_PER_KWH, MAX_TOTAL_PRICE_EUR_PER_KWH);

        const rawMarketPrice = totalPrice - gridFee;
        const endUtc = new Date(context.dtUtc.getTime() + 3_600_000);
        forecast.push({
          start: context.dtUtc.toISOString(),
          end: endUtc.toISOString(),
          duration_hours: 1,
          price: roundNumber(rawMarketPrice, 6),
          unit: "EUR/kWh",
          provider: this.key,
        });

        predictedTotalByHour.set(context.hourUtc, totalPrice);
        previousTotal = totalPrice;
      }

      const firstRawPrice = forecast[0]?.price;
      const priceSnapshot = typeof firstRawPrice === "number" && Number.isFinite(firstRawPrice)
        ? roundNumber(firstRawPrice + gridFee, 6)
        : null;
      this.logger.log(`Built ${forecast.length} synthetic price slot(s)`);
      return {forecast, priceSnapshot};
    } catch (error) {
      const message = `Synthetic price forecast failed: ${String(error)}`;
      this.logger.warn(message);
      ctx.warnings.push(message);
      return {forecast: [], priceSnapshot: null};
    }
  }

  private buildHistoricalHours(): HistoricalPriceHour[] {
    const cutoffMs = Date.now() - (HISTORY_LOOKBACK_DAYS * 86_400_000);
    const buckets = new Map<string, {sum: number; count: number}>();

    for (const record of this.storage.listAllHistoryAsc()) {
      const price = record.payload.price_eur_per_kwh;
      if (typeof price !== "number" || !Number.isFinite(price)) {
        continue;
      }
      const dtUtc = parseIso(record.payload.timestamp);
      if (!dtUtc || dtUtc.getTime() < cutoffMs) {
        continue;
      }
      const hourUtc = floorToUtcHour(dtUtc).toISOString();
      const bucket = buckets.get(hourUtc) ?? {sum: 0, count: 0};
      bucket.sum += price;
      bucket.count += 1;
      buckets.set(hourUtc, bucket);
    }

    return [...buckets.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([hourUtc, bucket]) => {
        const dtUtc = new Date(hourUtc);
        const local = toLocalParts(dtUtc);
        return {
          hourUtc,
          dtUtc,
          localHour: local.hour,
          weekday: local.weekday,
          month: local.month,
          season: seasonFromMonth(local.month),
          totalPriceEurPerKwh: bucket.count > 0 ? bucket.sum / bucket.count : DEFAULT_TOTAL_PRICE_EUR_PER_KWH,
        } satisfies HistoricalPriceHour;
      });
  }

  private async buildFutureContexts(start: Date, end: Date): Promise<FuturePriceContext[]> {
    const weatherResponses = await Promise.all(
      AUSTRIA_WEATHER_POINTS.map((location) => this.weatherService.getWeatherHours(location, start, end)),
    );
    const solarRows = await this.weatherService.getSolarProxyHours(AUSTRIA_SOLAR_POINTS, start, end);

    const aggregate = new Map<string, {
      dtUtc: Date;
      cloudSum: number;
      cloudCount: number;
      windSum: number;
      windCount: number;
      precipitationSum: number;
      precipitationCount: number;
      solarSum: number;
      solarCount: number;
    }>();

    for (const weatherRows of weatherResponses) {
      for (const row of weatherRows) {
        this.accumulateWeatherRow(aggregate, row);
      }
    }

    for (const row of solarRows) {
      const bucket = aggregate.get(row.hourUtc) ?? {
        dtUtc: new Date(row.hourUtc),
        cloudSum: 0,
        cloudCount: 0,
        windSum: 0,
        windCount: 0,
        precipitationSum: 0,
        precipitationCount: 0,
        solarSum: 0,
        solarCount: 0,
      };
      if (typeof row.expectedPowerW === "number" && Number.isFinite(row.expectedPowerW)) {
        bucket.solarSum += row.expectedPowerW;
        bucket.solarCount += 1;
      }
      aggregate.set(row.hourUtc, bucket);
    }

    const contexts: FuturePriceContext[] = [];
    for (let current = start.getTime(); current <= end.getTime(); current += 3_600_000) {
      const dtUtc = new Date(current);
      const hourUtc = dtUtc.toISOString();
      const bucket = aggregate.get(hourUtc);
      const local = toLocalParts(dtUtc);
      contexts.push({
        hourUtc,
        dtUtc,
        localHour: local.hour,
        weekday: local.weekday,
        month: local.month,
        season: seasonFromMonth(local.month),
        solarProxyW: bucket && bucket.solarCount > 0 ? bucket.solarSum / bucket.solarCount : 0,
        cloudCover: bucket && bucket.cloudCount > 0 ? bucket.cloudSum / bucket.cloudCount : null,
        windSpeed10m: bucket && bucket.windCount > 0 ? bucket.windSum / bucket.windCount : null,
        precipitationMm: bucket && bucket.precipitationCount > 0 ? bucket.precipitationSum / bucket.precipitationCount : null,
      });
    }
    return contexts;
  }

  private accumulateWeatherRow(
    aggregate: Map<string, {
      dtUtc: Date;
      cloudSum: number;
      cloudCount: number;
      windSum: number;
      windCount: number;
      precipitationSum: number;
      precipitationCount: number;
      solarSum: number;
      solarCount: number;
    }>,
    row: WeatherHourRecord,
  ): void {
    const bucket = aggregate.get(row.hourUtc) ?? {
      dtUtc: new Date(row.hourUtc),
      cloudSum: 0,
      cloudCount: 0,
      windSum: 0,
      windCount: 0,
      precipitationSum: 0,
      precipitationCount: 0,
      solarSum: 0,
      solarCount: 0,
    };
    if (typeof row.cloudCover === "number" && Number.isFinite(row.cloudCover)) {
      bucket.cloudSum += row.cloudCover;
      bucket.cloudCount += 1;
    }
    if (typeof row.windSpeed10m === "number" && Number.isFinite(row.windSpeed10m)) {
      bucket.windSum += row.windSpeed10m;
      bucket.windCount += 1;
    }
    if (typeof row.precipitationMm === "number" && Number.isFinite(row.precipitationMm)) {
      bucket.precipitationSum += row.precipitationMm;
      bucket.precipitationCount += 1;
    }
    aggregate.set(row.hourUtc, bucket);
  }
}

function buildBaselines(rows: HistoricalPriceHour[]): PriceBaselines {
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
  return {hourWeek, seasonHour, hourOnly};
}

function buildWeightedAverageMap(
  rows: HistoricalPriceHour[],
  keyFn: (row: HistoricalPriceHour) => string,
  nowMs: number,
): Map<string, number> {
  const totals = new Map<string, {weighted: number; total: number}>();
  for (const row of rows) {
    const key = keyFn(row);
    const ageDays = Math.max(0, (nowMs - row.dtUtc.getTime()) / 86_400_000);
    const weight = Math.exp(-ageDays / 35);
    const bucket = totals.get(key) ?? {weighted: 0, total: 0};
    bucket.weighted += row.totalPriceEurPerKwh * weight;
    bucket.total += weight;
    totals.set(key, bucket);
  }
  return new Map(
    [...totals.entries()]
      .filter(([, bucket]) => bucket.total > 0)
      .map(([key, bucket]) => [key, bucket.weighted / bucket.total]),
  );
}

function weightedAverage(rows: HistoricalPriceHour[], nowMs: number): number {
  let weightedSum = 0;
  let totalWeight = 0;
  for (const row of rows) {
    const ageDays = Math.max(0, (nowMs - row.dtUtc.getTime()) / 86_400_000);
    const weight = Math.exp(-ageDays / 35);
    weightedSum += row.totalPriceEurPerKwh * weight;
    totalWeight += weight;
  }
  return totalWeight > 0 ? weightedSum / totalWeight : DEFAULT_TOTAL_PRICE_EUR_PER_KWH;
}

function predictBaselineTotalPrice(
  context: FuturePriceContext,
  baselines: PriceBaselines,
  fallback: number,
): number {
  const hourWeek = baselines.hourWeek.get(`${context.weekday}:${context.localHour}`) ?? null;
  const seasonHour = baselines.seasonHour.get(`${context.season}:${context.localHour}`) ?? null;
  const hourOnly = baselines.hourOnly.get(context.localHour) ?? null;
  if (hourWeek != null && seasonHour != null && hourOnly != null) {
    return hourWeek * 0.58 + seasonHour * 0.24 + hourOnly * 0.18;
  }
  if (hourWeek != null && hourOnly != null) {
    return hourWeek * 0.72 + hourOnly * 0.28;
  }
  if (seasonHour != null && hourOnly != null) {
    return seasonHour * 0.65 + hourOnly * 0.35;
  }
  return hourWeek ?? seasonHour ?? hourOnly ?? fallback;
}

function computeWeatherAdjustment(context: FuturePriceContext): number {
  const solarNorm = clamp(context.solarProxyW / 850, 0, 1.4);
  const windNorm = clamp((context.windSpeed10m ?? 0) / 18, 0, 1.3);
  const cloudNorm = clamp((context.cloudCover ?? 0) / 100, 0, 1);
  const precipitationNorm = clamp((context.precipitationMm ?? 0) / 3, 0, 1.2);
  const isWeekday = context.weekday >= 0 && context.weekday <= 4;
  const morningPeak = isWeekday && context.localHour >= 7 && context.localHour <= 9 ? 0.008 : 0;
  const eveningPeak = isWeekday && context.localHour >= 17 && context.localHour <= 20 ? 0.018 : 0;
  const middayDip = context.localHour >= 10 && context.localHour <= 15 ? -0.01 : 0;
  const solarAdjustment = -0.03 * solarNorm;
  const windAdjustment = -0.012 * windNorm;
  const cloudAdjustment = solarNorm > 0.2 ? 0.004 * cloudNorm : 0;
  const precipitationAdjustment = 0.003 * precipitationNorm;
  const weekendAdjustment = context.weekday >= 5 && context.localHour >= 11 && context.localHour <= 15 ? -0.004 : 0;
  return solarAdjustment + windAdjustment + cloudAdjustment + precipitationAdjustment + morningPeak + eveningPeak + middayDip + weekendAdjustment;
}

function normalizeMaxHours(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : DEFAULT_MAX_HOURS;
}

function parseIso(value: string | null | undefined): Date | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function floorToUtcHour(value: Date): Date {
  const copy = new Date(value);
  copy.setUTCMinutes(0, 0, 0);
  return copy;
}

function ceilToUtcHour(value: Date): Date {
  const floored = floorToUtcHour(value);
  return floored.getTime() === value.getTime() ? floored : new Date(floored.getTime() + 3_600_000);
}

function toLocalParts(value: Date): {hour: number; weekday: number; month: number} {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: VIENNA_TIME_ZONE,
    hour: "numeric",
    month: "numeric",
    weekday: "short",
    hour12: false,
  });
  const parts = formatter.formatToParts(value);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? NaN);
  const month = Number(parts.find((part) => part.type === "month")?.value ?? NaN);
  const weekdayLabel = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
  return {
    hour: Number.isFinite(hour) ? hour : value.getUTCHours(),
    month: Number.isFinite(month) ? month : value.getUTCMonth() + 1,
    weekday: weekdayFromLabel(weekdayLabel),
  };
}

function weekdayFromLabel(label: string): number {
  switch (label.slice(0, 3).toLowerCase()) {
    case "mon": return 0;
    case "tue": return 1;
    case "wed": return 2;
    case "thu": return 3;
    case "fri": return 4;
    case "sat": return 5;
    case "sun": return 6;
    default: return 0;
  }
}

function seasonFromMonth(month: number): number {
  if (month === 12 || month === 1 || month === 2) {
    return 0;
  }
  if (month >= 3 && month <= 5) {
    return 1;
  }
  if (month >= 6 && month <= 8) {
    return 2;
  }
  return 3;
}

function average(values: number[]): number | null {
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function offsetHourIso(hourUtc: string, offsetHours: number): string {
  return new Date(new Date(hourUtc).getTime() + offsetHours * 3_600_000).toISOString();
}

function roundNumber(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
