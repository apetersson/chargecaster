import { Inject, Injectable, Logger } from "@nestjs/common";
import type { DemandForecastEntry, ForecastEra, HistoryPoint } from "@chargecaster/domain";
import { extractForecastEraPrice, extractForecastEraSolar, parseTemporal, TimeSlot } from "@chargecaster/domain";

import { StorageService, type WeatherHourRecord } from "../storage/storage.service";
import { LoadForecastInferenceService } from "../forecasting/load-forecast-inference.service";
import type { ConfigDocument } from "./schemas";
import { WeatherService, type WeatherLocation } from "./weather.service";

const DEFAULT_HOUSE_LOAD_W = 2200;
const MIN_HOUSE_LOAD_W = 150;
const MAX_HOUSE_LOAD_W = 15000;
const MAX_NEIGHBORS = 24;
const MIN_BASELINE_RATIO = 0.2;
const MAX_BASELINE_RATIO = 3.0;
const SHAPE_CALIBRATION_BLEND = 1.0;
const MAX_SHAPE_STD_RATIO = 1.095;

export type LoadForecastMethod = "catboost_model" | "hybrid_history_weather" | "cold_start";
export type LoadForecastActiveSource =
  | "runtime_current"
  | "bundled_seeded"
  | "candidate_not_promoted"
  | "fallback_no_artifact"
  | "fallback_schema_mismatch"
  | "fallback_runtime_unavailable";
export type LoadForecastRuntimeStatus = "serving" | "fallback" | "training" | "blocked";

interface HistoricalHour {
  hourUtc: string;
  localHour: number;
  weekday: number;
  weekOfYear: number;
  month: number;
  season: number;
  homePowerW: number;
  solarPowerW: number;
  priceEurPerKwh: number;
  temperature2m: number | null;
  cloudCover: number | null;
  windSpeed10m: number | null;
  precipitationMm: number | null;
  validTarget: boolean;
}

interface ForecastHourContext {
  start: Date;
  end: Date | null;
  hourUtc: string;
  localHour: number;
  weekday: number;
  weekOfYear: number;
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

export interface LoadForecastRuntimeMetadata {
  method: LoadForecastMethod;
  activeSource: LoadForecastActiveSource;
  modelVersion: string | null;
  featureSchemaVersion: string | null;
  trainedAt: string | null;
  trainingWindowEnd: string | null;
  runtimeStatus: LoadForecastRuntimeStatus;
}

export interface DemandForecastBuildInput {
  config: ConfigDocument;
  forecastEras: ForecastEra[];
  liveHomePowerW?: number | null;
}

@Injectable()
export class DemandForecastService {
  private readonly logger = new Logger(DemandForecastService.name);
  private lastRuntimeMetadata: LoadForecastRuntimeMetadata | null = null;

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(WeatherService) private readonly weatherService: WeatherService,
    @Inject(LoadForecastInferenceService) private readonly inferenceService: LoadForecastInferenceService,
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
    const modelForecast = await this.buildModelForecast(input.config, futureContexts, historicalHours, baselines, input.liveHomePowerW ?? null);
    if (modelForecast) {
      this.logger.log(`Built ${modelForecast.length} demand forecast entries from CatBoost`);
      return modelForecast;
    }

    if (historicalHours.length > 0) {
      const fallback = buildHybridFallbackForecast(futureContexts, historicalHours, baselines, input.liveHomePowerW ?? null);
      this.lastRuntimeMetadata = this.buildFallbackMetadata("hybrid_history_weather");
      this.logger.log(`Built ${fallback.length} demand forecast entries from hybrid fallback`);
      return fallback;
    }

    const coldStart = buildColdStartForecast(futureContexts);
    this.lastRuntimeMetadata = this.buildFallbackMetadata("cold_start");
    this.logger.log(`Built ${coldStart.length} demand forecast entries from cold start`);
    return coldStart;
  }

  getRuntimeMetadata(config: ConfigDocument): LoadForecastRuntimeMetadata {
    if (this.lastRuntimeMetadata) {
      return this.lastRuntimeMetadata;
    }
    return this.metadataFromInspection(this.inspectActiveArtifact(config));
  }

  private async buildModelForecast(
    config: ConfigDocument,
    contexts: ForecastHourContext[],
    historicalHours: HistoricalHour[],
    baselines: BaselineBundle,
    liveHomePowerW: number | null,
  ): Promise<DemandForecastEntry[] | null> {
    const inspection = this.inspectActiveArtifact(config);
    const activeArtifact = inspection.artifact;
    if (!activeArtifact) {
      this.lastRuntimeMetadata = this.metadataFromInspection(inspection);
      return null;
    }

    const historyByHour = new Map(historicalHours.map((row) => [row.hourUtc, row.homePowerW]));
    const rollingHomes = historicalHours.slice(-6).map((row) => row.homePowerW);
    if (!rollingHomes.length) {
      rollingHomes.push(DEFAULT_HOUSE_LOAD_W);
    }
    const futurePriceStats = buildFuturePriceStats(contexts);
    const forecast: DemandForecastEntry[] = [];

    for (let index = 0; index < contexts.length; index += 1) {
      const context = contexts[index];
      const baselineHousePowerW = predictBaselineHousePower(context, baselines);
      const features = buildFeatureVector({
        context,
        contexts,
        contextIndex: index,
        rollingHomes,
        historyByHour,
        futurePriceStats,
      });
      const predictionResult = await this.inferenceService.predict(config, [features]);
      if (!predictionResult) {
        this.lastRuntimeMetadata = {
          method: "hybrid_history_weather",
          activeSource: "fallback_runtime_unavailable",
          modelVersion: activeArtifact.manifest.model_version,
          featureSchemaVersion: activeArtifact.manifest.feature_schema_version,
          trainedAt: activeArtifact.manifest.trained_at,
          trainingWindowEnd: activeArtifact.manifest.training_window.end,
          runtimeStatus: "blocked",
        };
        return null;
      }

      const rawPrediction = predictionResult.predictions[0];
      const targetMode = activeArtifact.manifest.target_mode ?? "absolute_house_power_v1";
      let housePowerW = rawPrediction ?? baselineHousePowerW;
      if (targetMode === "baseline_delta_v1") {
        housePowerW = baselineHousePowerW + (rawPrediction ?? 0);
      } else if (targetMode === "baseline_ratio_v1") {
        const boundedRatio = clamp(rawPrediction ?? 1, MIN_BASELINE_RATIO, MAX_BASELINE_RATIO);
        housePowerW = baselineHousePowerW * boundedRatio;
      }
      housePowerW = clamp(housePowerW, MIN_HOUSE_LOAD_W, MAX_HOUSE_LOAD_W);
      if (index === 0 && typeof liveHomePowerW === "number" && Number.isFinite(liveHomePowerW)) {
        housePowerW = clamp(housePowerW * 0.7 + liveHomePowerW * 0.3, MIN_HOUSE_LOAD_W, MAX_HOUSE_LOAD_W);
      }

      forecast.push({
        start: context.start.toISOString(),
        end: context.end?.toISOString(),
        house_power_w: roundNumber(housePowerW, 3),
        baseline_house_power_w: roundNumber(baselineHousePowerW, 3),
        confidence: roundNumber(computeConfidence(historicalHours.length, index), 6),
        source: "catboost_model",
        model_version: activeArtifact.manifest.model_version,
      });

      rollingHomes.push(housePowerW);
      while (rollingHomes.length > 8) {
        rollingHomes.shift();
      }
    }

    const calibratedForecast = calibrateForecastShape(forecast, contexts, historicalHours, liveHomePowerW);
    this.lastRuntimeMetadata = {
      method: "catboost_model",
      activeSource: activeArtifact.activeSource,
      modelVersion: activeArtifact.manifest.model_version,
      featureSchemaVersion: activeArtifact.manifest.feature_schema_version,
      trainedAt: activeArtifact.manifest.trained_at,
      trainingWindowEnd: activeArtifact.manifest.training_window.end,
      runtimeStatus: "serving",
    };
    return calibratedForecast;
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
        weekOfYear: local.weekOfYear,
        month: local.month,
        season: seasonFromMonth(local.month),
        homePowerW: entry.homePowerW,
        solarPowerW: entry.solarPowerW,
        priceEurPerKwh: entry.priceEurPerKwh,
        temperature2m: weather?.temperature2m ?? null,
        cloudCover: weather?.cloudCover ?? null,
        windSpeed10m: weather?.windSpeed10m ?? null,
        precipitationMm: weather?.precipitationMm ?? null,
        validTarget: entry.validTarget,
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

  private metadataFromInspection(
    inspection: ReturnType<LoadForecastInferenceService["inspectActiveArtifact"]>,
  ): LoadForecastRuntimeMetadata {
    if (inspection.artifact) {
      return {
        method: "catboost_model",
        activeSource: inspection.artifact.activeSource,
        modelVersion: inspection.artifact.manifest.model_version,
        featureSchemaVersion: inspection.artifact.manifest.feature_schema_version,
        trainedAt: inspection.artifact.manifest.trained_at,
        trainingWindowEnd: inspection.artifact.manifest.training_window.end,
        runtimeStatus: "serving",
      };
    }
    if (inspection.reason === "schema_mismatch" || inspection.reason === "invalid_manifest") {
      return {
        method: "hybrid_history_weather",
        activeSource: "fallback_schema_mismatch",
        modelVersion: null,
        featureSchemaVersion: null,
        trainedAt: null,
        trainingWindowEnd: null,
        runtimeStatus: "blocked",
      };
    }
    return {
      method: "hybrid_history_weather",
      activeSource: "fallback_no_artifact",
      modelVersion: null,
      featureSchemaVersion: null,
      trainedAt: null,
      trainingWindowEnd: null,
      runtimeStatus: "fallback",
    };
  }

  private buildFallbackMetadata(method: "hybrid_history_weather" | "cold_start"): LoadForecastRuntimeMetadata {
    const previous = this.lastRuntimeMetadata;
    return {
      method,
      activeSource: previous?.activeSource ?? "fallback_no_artifact",
      modelVersion: previous?.modelVersion ?? null,
      featureSchemaVersion: previous?.featureSchemaVersion ?? null,
      trainedAt: previous?.trainedAt ?? null,
      trainingWindowEnd: previous?.trainingWindowEnd ?? null,
      runtimeStatus: previous?.runtimeStatus ?? "fallback",
    };
  }

  private inspectActiveArtifact(config: ConfigDocument): ReturnType<LoadForecastInferenceService["inspectActiveArtifact"]> {
    if ("inspectActiveArtifact" in this.inferenceService && typeof this.inferenceService.inspectActiveArtifact === "function") {
      return this.inferenceService.inspectActiveArtifact(config);
    }
    const artifact = this.inferenceService.getActiveArtifact(config);
    return artifact
      ? { artifact, reason: "ok" }
      : { artifact: null, reason: "no_artifact" };
  }
}

function buildHybridFallbackForecast(
  contexts: ForecastHourContext[],
  historicalHours: HistoricalHour[],
  baselines: BaselineBundle,
  liveHomePowerW: number | null,
): DemandForecastEntry[] {
  const recentHomes = historicalHours.slice(-3).map((row) => row.homePowerW);
  const recentBias = computeRecentBias(historicalHours, baselines);
  const rollingHomes = recentHomes.length ? [...recentHomes] : [DEFAULT_HOUSE_LOAD_W];

  return contexts.map((context, index) => {
    const baselineHousePowerW = predictBaselineHousePower(context, baselines);
    const lag1 = rollingHomes.at(-1) ?? baselineHousePowerW;
    const lag3 = average(rollingHomes.slice(-3)) ?? lag1;
    const neighborResult = predictFromNeighbors(historicalHours, context, lag1, lag3);
    let housePowerW =
      baselineHousePowerW * 0.5 +
      neighborResult.value * 0.35 +
      lag3 * 0.15 +
      recentBias * 0.4;
    if (index === 0 && typeof liveHomePowerW === "number" && Number.isFinite(liveHomePowerW)) {
      housePowerW = housePowerW * 0.55 + liveHomePowerW * 0.45;
    }
    housePowerW = clamp(housePowerW, MIN_HOUSE_LOAD_W, MAX_HOUSE_LOAD_W);
    rollingHomes.push(housePowerW);
    while (rollingHomes.length > 6) {
      rollingHomes.shift();
    }
    return {
      start: context.start.toISOString(),
      end: context.end?.toISOString(),
      house_power_w: roundNumber(housePowerW, 3),
      baseline_house_power_w: roundNumber(baselineHousePowerW, 3),
      confidence: roundNumber(computeConfidence(historicalHours.length, index), 6),
      source: "hybrid_history_weather",
      model_version: undefined,
    } satisfies DemandForecastEntry;
  });
}

function calibrateForecastShape(
  forecast: DemandForecastEntry[],
  contexts: ForecastHourContext[],
  historicalHours: HistoricalHour[],
  liveHomePowerW: number | null,
): DemandForecastEntry[] {
  const calibrationIndices = selectCalibrationIndices(contexts);
  if (calibrationIndices.length < 4) {
    return forecast;
  }
  const calibrationContexts = calibrationIndices.map((index) => contexts[index]!).filter(Boolean);
  const referenceValues = buildRecentShapeReference(calibrationContexts, historicalHours);
  if (!referenceValues || referenceValues.length !== calibrationIndices.length) {
    return forecast;
  }
  const orderedIndices = calibrationIndices
    .map((index) => ({ index, value: forecast[index]?.house_power_w ?? DEFAULT_HOUSE_LOAD_W }))
    .sort((left, right) => left.value - right.value)
    .map((entry) => entry.index);
  const sortedReference = [...referenceValues].sort((left, right) => left - right);
  const calibrated = forecast.map((entry) => ({ ...entry }));
  for (const [rank, index] of orderedIndices.entries()) {
    const mapped = sortedReference[rank] ?? calibrated[index]!.house_power_w;
    calibrated[index]!.house_power_w = roundNumber(
      clamp(
        calibrated[index]!.house_power_w * (1 - SHAPE_CALIBRATION_BLEND) + mapped * SHAPE_CALIBRATION_BLEND,
        MIN_HOUSE_LOAD_W,
        MAX_HOUSE_LOAD_W,
      ),
      3,
    );
  }
  if (typeof liveHomePowerW === "number" && Number.isFinite(liveHomePowerW) && calibrated[0]) {
    calibrated[0].house_power_w = roundNumber(
      clamp(calibrated[0].house_power_w * 0.7 + liveHomePowerW * 0.3, MIN_HOUSE_LOAD_W, MAX_HOUSE_LOAD_W),
      3,
    );
  }
  const referenceStd = populationStd(referenceValues);
  const calibratedValues = calibrationIndices.map((index) => calibrated[index]!.house_power_w);
  const calibratedStd = populationStd(calibratedValues);
  if (referenceStd > 0 && calibratedStd > referenceStd * MAX_SHAPE_STD_RATIO) {
    const targetStd = referenceStd * MAX_SHAPE_STD_RATIO;
    const center = average(calibratedValues) ?? DEFAULT_HOUSE_LOAD_W;
    const scale = targetStd / calibratedStd;
    for (const index of calibrationIndices) {
      calibrated[index]!.house_power_w = roundNumber(
        clamp(center + (calibrated[index]!.house_power_w - center) * scale, MIN_HOUSE_LOAD_W, MAX_HOUSE_LOAD_W),
        3,
      );
    }
  }
  return calibrated;
}

function selectCalibrationIndices(contexts: ForecastHourContext[]): number[] {
  const first = contexts[0];
  if (!first) {
    return [];
  }
  const cutoffMs = first.start.getTime() + 24 * 3_600_000;
  return contexts
    .map((context, index) => ({ context, index }))
    .filter(({ context }) => context.start.getTime() < cutoffMs)
    .map(({ index }) => index);
}

function buildRecentShapeReference(
  contexts: ForecastHourContext[],
  historicalHours: HistoricalHour[],
): number[] | null {
  const latest = historicalHours.at(-1);
  if (!latest) {
    return null;
  }
  const cutoffMs = new Date(latest.hourUtc).getTime() - 7 * 24 * 3_600_000;
  const recent = historicalHours.filter((row) => row.validTarget && new Date(row.hourUtc).getTime() > cutoffMs);
  if (recent.length < 24 * 3) {
    return null;
  }
  const byHour = new Map<number, number[]>();
  for (const row of recent) {
    const bucket = byHour.get(row.localHour) ?? [];
    bucket.push(row.homePowerW);
    byHour.set(row.localHour, bucket);
  }
  const reference: number[] = [];
  for (const context of contexts) {
    const samples = byHour.get(context.localHour);
    if (!samples?.length) {
      return null;
    }
    reference.push(average(samples) ?? DEFAULT_HOUSE_LOAD_W);
  }
  return reference;
}

function buildColdStartForecast(contexts: ForecastHourContext[]): DemandForecastEntry[] {
  return contexts.map((context, index) => ({
    start: context.start.toISOString(),
    end: context.end?.toISOString(),
    house_power_w: DEFAULT_HOUSE_LOAD_W,
    baseline_house_power_w: DEFAULT_HOUSE_LOAD_W,
    confidence: roundNumber(computeConfidence(0, index), 6),
    source: "cold_start",
    model_version: undefined,
  }));
}

function buildFeatureVector(input: {
  context: ForecastHourContext;
  contexts: ForecastHourContext[];
  contextIndex: number;
  rollingHomes: number[];
  historyByHour: Map<string, number>;
  futurePriceStats: { next6hMean: number; next24hPercentile: number; next24hTopQuartileFlag: number }[];
}): number[] {
  const { context, contexts, contextIndex, rollingHomes, historyByHour, futurePriceStats } = input;
  const lagPrevHour = rollingHomes.at(-1) ?? DEFAULT_HOUSE_LOAD_W;
  const lagMean3 = average(rollingHomes.slice(-3)) ?? lagPrevHour;
  const lagMean6 = average(rollingHomes.slice(-6)) ?? lagMean3;
  const sameHourPrevDay = historyByHour.get(new Date(context.start.getTime() - 24 * 3_600_000).toISOString()) ?? null;
  const sameHourPrevWeek = historyByHour.get(new Date(context.start.getTime() - 7 * 24 * 3_600_000).toISOString()) ?? null;
  const solarNext3hMean = average(contexts.slice(contextIndex, contextIndex + 3).map((entry) => entry.solarPowerW)) ?? context.solarPowerW;
  const solarNext6hMean = average(contexts.slice(contextIndex, contextIndex + 6).map((entry) => entry.solarPowerW)) ?? context.solarPowerW;
  const futurePrice = futurePriceStats[contextIndex] ?? {
    next6hMean: context.priceEurPerKwh,
    next24hPercentile: 0.5,
    next24hTopQuartileFlag: 0,
  };
  return [
    context.localHour,
    context.weekday,
    isWeekend(context.weekday) ? 1 : 0,
    context.weekOfYear,
    context.month,
    context.season,
    coalesceNumber(context.temperature2m),
    coalesceNumber(context.cloudCover),
    coalesceNumber(context.windSpeed10m),
    coalesceNumber(context.precipitationMm),
    context.solarPowerW,
    solarNext3hMean,
    solarNext6hMean,
    context.priceEurPerKwh,
    futurePrice.next6hMean,
    futurePrice.next24hPercentile,
    futurePrice.next24hTopQuartileFlag,
    lagPrevHour,
    lagMean3,
    lagMean6,
    sameHourPrevDay ?? 0,
    sameHourPrevWeek ?? 0,
    Number(sameHourPrevDay == null),
    Number(sameHourPrevWeek == null),
  ];
}

function buildFuturePriceStats(
  contexts: ForecastHourContext[],
): { next6hMean: number; next24hPercentile: number; next24hTopQuartileFlag: number }[] {
  return contexts.map((context, index) => {
    const next6h = contexts.slice(index, index + 6).map((entry) => entry.priceEurPerKwh);
    const next24h = contexts.slice(index, index + 24).map((entry) => entry.priceEurPerKwh);
    const sorted24h = [...next24h].sort((left, right) => left - right);
    const percentile = sorted24h.length <= 1
      ? 0.5
      : sorted24h.findIndex((value) => value >= context.priceEurPerKwh) / (sorted24h.length - 1);
    return {
      next6hMean: average(next6h) ?? context.priceEurPerKwh,
      next24hPercentile: percentile >= 0 ? percentile : 0.5,
      next24hTopQuartileFlag: percentile >= 0.75 ? 1 : 0,
    };
  });
}

export function aggregateHistoryByHour(historyPoints: HistoryPoint[]): {
  hourUtc: string;
  homePowerW: number;
  solarPowerW: number;
  priceEurPerKwh: number;
  validTarget: boolean;
}[] {
  const grouped = new Map<string, {
    homeSum: number;
    homeCount: number;
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
      solarSum: 0,
      solarCount: 0,
      priceSum: 0,
      priceCount: 0,
    };
    bucket.homeSum += point.home_power_w;
    bucket.homeCount += 1;
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
      homePowerW: bucket.homeCount >= 6 ? bucket.homeSum / bucket.homeCount : DEFAULT_HOUSE_LOAD_W,
      solarPowerW: bucket.solarCount > 0 ? bucket.solarSum / bucket.solarCount : 0,
      priceEurPerKwh: bucket.priceCount > 0 ? bucket.priceSum / bucket.priceCount : 0,
      validTarget: bucket.homeCount >= 6,
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

function predictBaselineHousePower(context: ForecastHourContext | HistoricalHour, baselines: BaselineBundle): number {
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
  const deltas = recent.map((row) => row.homePowerW - predictBaselineHousePower(row, baselines));
  return average(deltas) ?? 0;
}

function computeConfidence(historyHours: number, forecastIndex: number): number {
  return clamp(
    0.25 + (historyHours >= 24 ? 0.25 : historyHours >= 12 ? 0.15 : 0) + (forecastIndex < 2 ? 0.05 : 0),
    0,
    1,
  );
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
    weekOfYear: local.weekOfYear,
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

function toTemporalParts(date: Date, timeZone: string): { weekday: number; hour: number; month: number; weekOfYear: number } {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
    month: "2-digit",
    year: "numeric",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const weekdayLabel = parts.find((part) => part.type === "weekday")?.value ?? "Mon";
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "1");
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "1970");
  const day = Number(parts.find((part) => part.type === "day")?.value ?? "1");
  return {
    weekday: weekdayLabelToIndex(weekdayLabel),
    hour,
    month,
    weekOfYear: isoWeekNumber(year, month, day),
  };
}

function weekdayLabelToIndex(value: string): number {
  switch (value.slice(0, 3).toLowerCase()) {
    case "mon":
      return 0;
    case "tue":
      return 1;
    case "wed":
      return 2;
    case "thu":
      return 3;
    case "fri":
      return 4;
    case "sat":
      return 5;
    case "sun":
      return 6;
    default:
      return 0;
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
  return weekday === 5 || weekday === 6;
}

function isoWeekNumber(year: number, month: number, day: number): number {
  const target = new Date(Date.UTC(year, month - 1, day));
  const dayNr = (target.getUTCDay() + 6) % 7;
  target.setUTCDate(target.getUTCDate() - dayNr + 3);
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
  const firstDayNr = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNr + 3);
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / 604_800_000);
}

function average(values: number[]): number | null {
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function populationStd(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  const avg = average(values) ?? 0;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
}

function roundNumber(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function coalesceNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function floorToUtcHour(date: Date): Date {
  const result = new Date(date);
  result.setUTCMinutes(0, 0, 0);
  return result;
}
