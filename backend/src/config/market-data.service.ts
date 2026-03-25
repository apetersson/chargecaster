import { Inject, Injectable, Logger } from "@nestjs/common";

import {
  derivePriceSnapshot,
  EnergyPrice,
  normalizePriceSlots,
  type RawForecastEntry,
  type SimulationConfig,
} from "@chargecaster/domain";
import type { ConfigDocument, EnergyPriceConfig } from "./schemas";
import { AwattarProvider } from "./providers/awattar.provider";
import { EntsoeNewProvider } from "./providers/entsoe_new.provider";
import { FromEvccProvider } from "./providers/from_evcc.provider";
import { StatisticalPriceProvider } from "./providers/statistical.provider";
import { SynteticPriceProvider } from "./providers/synthetic.provider";
import type { EnergyPriceProvider, EnergyPriceProviderContext } from "./providers/provider.types";
import { parseTimestamp } from "../simulation/solar";
import { PriceForecastInferenceService } from "../forecasting/price-forecast-inference.service";
import { StorageService } from "../storage/storage.service";
import { WeatherService } from "./weather.service";

const DEFAULT_SLOT_MS = 3_600_000;

type ProviderKey = "entsoe" | "awattar" | "from_evcc" | "syntetic" | "educatedGuess";

interface ConfiguredProvider {
  key: ProviderKey;
  priority: number;
}

export interface PriceProviderForecast {
  key: ProviderKey;
  priority: number;
  forecast: RawForecastEntry[];
}

interface SlotWindow {
  startMs: number;
  endMs: number;
}

function withProvider(entries: RawForecastEntry[], provider: ProviderKey): RawForecastEntry[] {
  return entries.map((entry) => ({...entry, provider}));
}

function resolveForecastWindow(entry: RawForecastEntry): SlotWindow | null {
  const start = parseTimestamp(entry.start ?? entry.from ?? null);
  if (!start) {
    return null;
  }

  const startMs = start.getTime();
  const explicitEnd = parseTimestamp(entry.end ?? entry.to ?? null);
  let endMs = explicitEnd && explicitEnd.getTime() > startMs ? explicitEnd.getTime() : null;

  const durationHours = Number(entry.duration_hours ?? entry.durationHours ?? Number.NaN);
  if (endMs == null && Number.isFinite(durationHours) && durationHours > 0) {
    endMs = startMs + durationHours * DEFAULT_SLOT_MS;
  }

  const durationMinutes = Number(entry.duration_minutes ?? entry.durationMinutes ?? Number.NaN);
  if (endMs == null && Number.isFinite(durationMinutes) && durationMinutes > 0) {
    endMs = startMs + durationMinutes * 60_000;
  }

  endMs ??= startMs + DEFAULT_SLOT_MS;
  if (endMs <= startMs) {
    return null;
  }

  return {startMs, endMs};
}

function windowsOverlap(left: SlotWindow, right: SlotWindow): boolean {
  return left.startMs < right.endMs && right.startMs < left.endMs;
}

function compareEntriesByStart(left: RawForecastEntry, right: RawForecastEntry): number {
  const leftStart = resolveForecastWindow(left)?.startMs ?? Number.MAX_SAFE_INTEGER;
  const rightStart = resolveForecastWindow(right)?.startMs ?? Number.MAX_SAFE_INTEGER;
  if (leftStart !== rightStart) {
    return leftStart - rightStart;
  }
  const leftEnd = resolveForecastWindow(left)?.endMs ?? Number.MAX_SAFE_INTEGER;
  const rightEnd = resolveForecastWindow(right)?.endMs ?? Number.MAX_SAFE_INTEGER;
  return leftEnd - rightEnd;
}

function overlayForecastEntries(
  base: RawForecastEntry[],
  overlay: RawForecastEntry[],
): RawForecastEntry[] {
  const overlayWindows = overlay
    .map((entry) => resolveForecastWindow(entry))
    .filter((window): window is SlotWindow => window !== null);

  const retainedBase = base.filter((entry) => {
    const window = resolveForecastWindow(entry);
    if (!window) {
      return false;
    }
    return !overlayWindows.some((overlayWindow) => windowsOverlap(window, overlayWindow));
  });

  return [...retainedBase, ...overlay].sort(compareEntriesByStart);
}

@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);

  constructor(
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(WeatherService) private readonly weatherService: WeatherService,
    @Inject(PriceForecastInferenceService) private readonly priceForecastInference: PriceForecastInferenceService,
  ) {}

  async collect(
    configDocument: ConfigDocument,
    config: EnergyPriceConfig | undefined,
    simulationConfig: SimulationConfig,
    warnings: string[],
    evccFallback?: RawForecastEntry[],
  ): Promise<{ forecast: RawForecastEntry[]; providerForecasts: PriceProviderForecast[]; priceSnapshot: number | null }> {
    const providers: ConfiguredProvider[] = [];
    if (config?.awattar) providers.push({key: "awattar", priority: config.awattar.priority});
    if (config?.entsoe) providers.push({key: "entsoe", priority: config.entsoe.priority});
    if (config?.from_evcc) providers.push({key: "from_evcc", priority: config.from_evcc.priority});
    const synteticCfg = config?.syntetic ?? config?.synthetic;
    if (synteticCfg) providers.push({key: "syntetic", priority: synteticCfg.priority});
    if (config?.educatedGuess) providers.push({key: "educatedGuess", priority: config.educatedGuess.priority});
    providers.sort((a, b) => a.priority - b.priority);

    const awattarCfg = config?.awattar;
    const entsoeCfg = config?.entsoe;
    const fromEvccCfg = config?.from_evcc;
    const educatedGuessCfg = config?.educatedGuess;
    const collected: PriceProviderForecast[] = [];

    for (const provider of providers) {
      this.logger.log(`Collecting market data via provider ${provider.key}`);
      let impl: EnergyPriceProvider | null = null;
      if (provider.key === "awattar") {
        if (!awattarCfg) {
          throw new Error("price.energy.awattar is referenced by priority but missing in config");
        }
        impl = new AwattarProvider(awattarCfg);
      } else if (provider.key === "entsoe") {
        if (!entsoeCfg) {
          throw new Error("price.energy.entsoe is referenced by priority but missing in config");
        }
        impl = new EntsoeNewProvider(entsoeCfg);
      } else if (provider.key === "from_evcc") {
        if (!fromEvccCfg) {
          throw new Error("price.energy.from_evcc is referenced by priority but missing in config");
        }
        impl = new FromEvccProvider(Array.isArray(evccFallback) ? evccFallback : [], fromEvccCfg);
      } else if (provider.key === "educatedGuess") {
        if (!educatedGuessCfg) {
          throw new Error("price.energy.educatedGuess is referenced by priority but missing in config");
        }
        impl = new StatisticalPriceProvider(this.storage, this.weatherService, this.priceForecastInference, educatedGuessCfg);
      } else {
        if (!synteticCfg) {
          throw new Error("price.energy.syntetic is referenced by priority but missing in config");
        }
        impl = new SynteticPriceProvider(this.storage, this.weatherService, synteticCfg);
      }

      const ctx: EnergyPriceProviderContext = {simulationConfig, configDocument, warnings};
      const {forecast, priceSnapshot} = await impl.collect(ctx);
      this.logger.verbose(
        `Provider ${provider.key} returned forecast=${forecast.length}, price_snapshot=${priceSnapshot ?? "n/a"}`,
      );

      if (!forecast.length) {
        this.logger.warn(`Provider ${provider.key} returned no usable price slots; trying next provider`);
        continue;
      }

      collected.push({
        key: provider.key,
        priority: provider.priority,
        forecast: withProvider(forecast, provider.key),
      });
    }

    if (!collected.length) {
      return {forecast: [], providerForecasts: [], priceSnapshot: null};
    }

    const mergedForecast = [...collected]
      .sort((left, right) => right.priority - left.priority)
      .reduce<RawForecastEntry[]>((forecast, providerForecast) =>
        overlayForecastEntries(forecast, providerForecast.forecast), []);

    const mergedSnapshot = derivePriceSnapshot(
      normalizePriceSlots(mergedForecast),
      EnergyPrice.fromEurPerKwh(simulationConfig.price.grid_fee_eur_per_kwh ?? 0),
    )?.eurPerKwh ?? null;

    this.logger.verbose(
      `Merged ${collected.length} provider forecast(s) into ${mergedForecast.length} blended slot(s)`,
    );

    return {
      forecast: mergedForecast,
      providerForecasts: collected,
      priceSnapshot: mergedSnapshot,
    };
  }
}
