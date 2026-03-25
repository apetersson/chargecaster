import { Inject, Injectable, Logger } from "@nestjs/common";

import {
  derivePriceSnapshot,
  EnergyPrice,
  normalizePriceSlots,
  type RawForecastEntry,
  type SimulationConfig,
} from "@chargecaster/domain";
import type { EnergyPriceConfig } from "./schemas";
import { AwattarProvider } from "./providers/awattar.provider";
import { EntsoeNewProvider } from "./providers/entsoe_new.provider";
import { FromEvccProvider } from "./providers/from_evcc.provider";
import { SyntheticPriceProvider } from "./providers/synthetic.provider";
import type { EnergyPriceProvider, EnergyPriceProviderContext } from "./providers/provider.types";
import { parseTimestamp } from "../simulation/solar";
import { StorageService } from "../storage/storage.service";
import { WeatherService } from "./weather.service";

const DEFAULT_SLOT_MS = 3_600_000;

type ProviderKey = "entsoe" | "awattar" | "from_evcc" | "synthetic";

interface ConfiguredProvider {
  key: ProviderKey;
  prio: number;
}

interface CollectedProviderForecast {
  key: ProviderKey;
  prio: number;
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
  ) {}

  async collect(
    config: EnergyPriceConfig | undefined,
    simulationConfig: SimulationConfig,
    warnings: string[],
    evccFallback?: RawForecastEntry[],
  ): Promise<{ forecast: RawForecastEntry[]; accurateForecast: RawForecastEntry[]; guesstimateForecast: RawForecastEntry[]; priceSnapshot: number | null }> {
    const providers: ConfiguredProvider[] = [];
    if (config?.awattar) providers.push({key: "awattar", prio: config.awattar.priority});
    if (config?.entsoe) providers.push({key: "entsoe", prio: config.entsoe.priority});
    if (config?.from_evcc) providers.push({key: "from_evcc", prio: config.from_evcc.priority});
    if (config?.synthetic) providers.push({key: "synthetic", prio: config.synthetic.priority});
    providers.sort((a, b) => a.prio - b.prio);

    const awattarCfg = config?.awattar;
    const entsoeCfg = config?.entsoe;
    const fromEvccCfg = config?.from_evcc;
    const syntheticCfg = config?.synthetic;
    const collected: CollectedProviderForecast[] = [];

    for (const p of providers) {
      this.logger.log(`Collecting market data via provider ${p.key}`);
      let impl: EnergyPriceProvider | null = null;
      if (p.key === "awattar") {
        if (!awattarCfg) {
          throw new Error("price.energy.awattar is referenced by priority but missing in config");
        }
        impl = new AwattarProvider(awattarCfg);
      } else if (p.key === "entsoe") {
        if (!entsoeCfg) {
          throw new Error("price.energy.entsoe is referenced by priority but missing in config");
        }
        impl = new EntsoeNewProvider(entsoeCfg);
      } else if (p.key === "from_evcc") {
        if (!fromEvccCfg) {
          throw new Error("price.energy.from_evcc is referenced by priority but missing in config");
        }
        impl = new FromEvccProvider(Array.isArray(evccFallback) ? evccFallback : [], fromEvccCfg);
      } else {
        if (!syntheticCfg) {
          throw new Error("price.energy.synthetic is referenced by priority but missing in config");
        }
        impl = new SyntheticPriceProvider(this.storage, this.weatherService, syntheticCfg);
      }
      const ctx: EnergyPriceProviderContext = {simulationConfig, warnings};
      const {forecast, priceSnapshot} = await impl.collect(ctx);
      this.logger.verbose(
        `Provider ${p.key} returned forecast=${forecast.length}, price_snapshot=${priceSnapshot ?? "n/a"}`,
      );
      if (forecast.length) {
        collected.push({
          key: p.key,
          prio: p.prio,
          forecast: withProvider(forecast, p.key),
        });
        continue;
      }
      this.logger.warn(`Provider ${p.key} returned no usable price slots; trying next provider`);
    }

    if (!collected.length) {
      return {forecast: [], accurateForecast: [], guesstimateForecast: [], priceSnapshot: null};
    }

    const orderedByPrecedence = collected.sort((left, right) => right.prio - left.prio);
    const mergedForecast = orderedByPrecedence
      .reduce<RawForecastEntry[]>((forecast, providerForecast) =>
        overlayForecastEntries(forecast, providerForecast.forecast), []);

    const accurateForecast = orderedByPrecedence
      .filter((providerForecast) => providerForecast.key !== "synthetic")
      .reduce<RawForecastEntry[]>((forecast, providerForecast) =>
        overlayForecastEntries(forecast, providerForecast.forecast), []);

    const guesstimateForecast = orderedByPrecedence
      .filter((providerForecast) => providerForecast.key === "synthetic")
      .reduce<RawForecastEntry[]>((forecast, providerForecast) =>
        overlayForecastEntries(forecast, providerForecast.forecast), []);

    const mergedSnapshot = derivePriceSnapshot(
      normalizePriceSlots(mergedForecast),
      EnergyPrice.fromEurPerKwh(simulationConfig.price.grid_fee_eur_per_kwh ?? 0),
    )?.eurPerKwh ?? null;

    this.logger.verbose(
      `Merged ${collected.length} provider forecast(s) into ${mergedForecast.length} blended slot(s) ` +
      `(accurate=${accurateForecast.length}, guesstimate=${guesstimateForecast.length})`,
    );

    return {
      forecast: mergedForecast,
      accurateForecast,
      guesstimateForecast,
      priceSnapshot: mergedSnapshot,
    };
  }
}
