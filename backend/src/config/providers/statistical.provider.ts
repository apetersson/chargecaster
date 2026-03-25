import { Logger } from "@nestjs/common";

import type { EducatedGuessPriceConfig } from "../schemas";
import { WeatherService } from "../weather.service";
import { StorageService } from "../../storage/storage.service";
import { PriceForecastInferenceService } from "../../forecasting/price-forecast-inference.service";
import { EnergyPriceProvider, EnergyPriceProviderContext, EnergyPriceProviderResult } from "./provider.types";
import {
  DEFAULT_PRICE_FORECAST_HOURS,
  buildAustriaWideFuturePriceContexts,
  buildHeuristicTotalPriceSeries,
  buildHistoricalPriceHours,
  buildRawMarketForecast,
  clamp,
  normalizePriceForecastHorizon,
  offsetHourIso,
  roundNumber,
} from "./synthetic.provider";

const DEFAULT_BLEND_RATIO = 0.82;
const MIN_TOTAL_PRICE_EUR_PER_KWH = 0.04;
const MAX_TOTAL_PRICE_EUR_PER_KWH = 0.65;

export class StatisticalPriceProvider implements EnergyPriceProvider {
  readonly key = "educatedGuess";
  private readonly logger = new Logger(StatisticalPriceProvider.name);

  constructor(
    private readonly storage: StorageService,
    private readonly weatherService: WeatherService,
    private readonly inferenceService: PriceForecastInferenceService,
    private readonly cfg?: EducatedGuessPriceConfig,
  ) {}

  async collect(ctx: EnergyPriceProviderContext): Promise<EnergyPriceProviderResult> {
    const artifact = this.inferenceService.getActiveArtifact(ctx.configDocument);
    if (!artifact) {
      const message = "EducatedGuess price forecast skipped: no trained price-forecast artifact found.";
      this.logger.warn(message);
      ctx.warnings.push(message);
      return {forecast: [], priceSnapshot: null};
    }

    const maxHours = normalizePriceForecastHorizon(this.cfg?.max_hours ?? DEFAULT_PRICE_FORECAST_HOURS);
    const history = buildHistoricalPriceHours(this.storage);
    if (!history.length) {
      const message = "EducatedGuess price forecast skipped: no historical price data available.";
      this.logger.warn(message);
      ctx.warnings.push(message);
      return {forecast: [], priceSnapshot: null};
    }

    try {
      const start = ceilToUtcHour(new Date());
      const end = new Date(start.getTime() + Math.max(0, maxHours - 1) * 3_600_000);
      const contexts = await buildAustriaWideFuturePriceContexts(this.weatherService, start, end);
      if (!contexts.length) {
        const message = "EducatedGuess price forecast skipped: weather context unavailable.";
        this.logger.warn(message);
        ctx.warnings.push(message);
        return {forecast: [], priceSnapshot: null};
      }

      const heuristicTotals = buildHeuristicTotalPriceSeries(history, contexts);
      const historyByHour = new Map(history.map((row) => [row.hourUtc, row.totalPriceEurPerKwh]));
      const recentMean24 = average(history.slice(-24).map((row) => row.totalPriceEurPerKwh));
      const recentMean168 = average(history.slice(-168).map((row) => row.totalPriceEurPerKwh));
      const predictedByHour = new Map<string, number>();
      let previousTotal = history[history.length - 1]?.totalPriceEurPerKwh ?? heuristicTotals[0] ?? 0.22;
      const blendRatio = clamp(this.cfg?.heuristic_blend_ratio ?? DEFAULT_BLEND_RATIO, 0, 1);
      const totalPrices: number[] = [];

      for (let index = 0; index < contexts.length; index += 1) {
        const context = contexts[index];
        const heuristic = heuristicTotals[index] ?? previousTotal;
        const lag24 = predictedByHour.get(offsetHourIso(context.hourUtc, -24))
          ?? historyByHour.get(offsetHourIso(context.hourUtc, -24))
          ?? heuristic;
        const lag48 = historyByHour.get(offsetHourIso(context.hourUtc, -48)) ?? lag24;
        const lag168 = historyByHour.get(offsetHourIso(context.hourUtc, -168)) ?? lag48;
        const features = [[
          context.localHour,
          context.weekday,
          context.month,
          context.season,
          Math.sin((context.localHour / 24) * Math.PI * 2),
          Math.cos((context.localHour / 24) * Math.PI * 2),
          Math.sin((context.weekday / 7) * Math.PI * 2),
          Math.cos((context.weekday / 7) * Math.PI * 2),
          heuristic,
          previousTotal,
          lag24,
          lag48,
          lag168,
          recentMean24 ?? heuristic,
          recentMean168 ?? (recentMean24 ?? heuristic),
          context.solarProxyW,
          context.cloudCover ?? -1,
          context.windSpeed10m ?? -1,
          context.precipitationMm ?? -1,
          index,
        ]];
        const inference = await this.inferenceService.predict(ctx.configDocument, features);
        if (!inference) {
          const message = `EducatedGuess price forecast skipped: failed to run CatBoost artifact at ${artifact.modelPath}`;
          this.logger.warn(message);
          ctx.warnings.push(message);
          return {forecast: [], priceSnapshot: null};
        }
        const rawPrediction = inference.predictions[0] ?? heuristic;
        const blendedPrediction = clamp(
          rawPrediction * blendRatio + heuristic * (1 - blendRatio),
          MIN_TOTAL_PRICE_EUR_PER_KWH,
          MAX_TOTAL_PRICE_EUR_PER_KWH,
        );
        const totalPrice = roundNumber(blendedPrediction, 6);
        totalPrices.push(totalPrice);
        predictedByHour.set(context.hourUtc, totalPrice);
        previousTotal = totalPrice;
      }

      const gridFee = ctx.simulationConfig.price.grid_fee_eur_per_kwh ?? 0;
      const forecast = buildRawMarketForecast(this.key, contexts, totalPrices, gridFee);
      const firstRawPrice = forecast[0]?.price;
      const priceSnapshot = typeof firstRawPrice === "number" && Number.isFinite(firstRawPrice)
        ? roundNumber(firstRawPrice + gridFee, 6)
        : null;
      this.logger.log(`Built ${forecast.length} educatedGuess price slot(s) from ${artifact.manifest.model_version}`);
      return {forecast, priceSnapshot};
    } catch (error) {
      const message = `EducatedGuess price forecast failed: ${String(error)}`;
      this.logger.warn(message);
      ctx.warnings.push(message);
      return {forecast: [], priceSnapshot: null};
    }
  }
}

function average(values: number[]): number | null {
  if (!values.length) {
    return null;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ceilToUtcHour(value: Date): Date {
  const copy = new Date(value);
  copy.setUTCMinutes(0, 0, 0);
  return copy.getTime() === value.getTime() ? copy : new Date(copy.getTime() + 3_600_000);
}
