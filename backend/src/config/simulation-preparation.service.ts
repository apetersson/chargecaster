import { Inject, Injectable, Logger } from "@nestjs/common";

import type { ForecastEra, RawForecastEntry, RawSolarEntry, SimulationConfig } from "@chargecaster/domain";
import { parseTimestamp } from "../simulation/solar";
import type { ConfigDocument } from "./schemas";
import { SimulationConfigFactory } from "./simulation-config.factory";
import { MarketDataService } from "./market-data.service";
import { EvccDataService } from "./evcc-data.service";
import { ForecastAssemblyService } from "./forecast-assembly.service";

export interface PreparedSimulation {
  simulationConfig: SimulationConfig;
  liveState: { battery_soc?: number | null };
  forecast: RawForecastEntry[];
  warnings: string[];
  errors: string[];
  priceSnapshot: number | null;
  solarForecast: RawSolarEntry[];
  forecastEras: ForecastEra[];
  liveGridPowerW: number | null;
  liveSolarPowerW: number | null;
  liveHomePowerW: number | null;
  intervalSeconds: number | null;
}

// Fall back to hourly slots when upstream data omits a duration.
const DEFAULT_SLOT_MS = 60 * 60 * 1000;

export function trimForecastEntriesToFuture(
  entries: RawForecastEntry[],
  nowMs: number = Date.now(),
): RawForecastEntry[] {
  // Drop slots that finished already and shorten the active slot to start at `now`.
  return entries.reduce<RawForecastEntry[]>((acc, entry) => {
    const trimmed = trimForecastEntry(entry, nowMs);
    if (trimmed) {
      acc.push(trimmed);
    }
    return acc;
  }, []);
}

export function trimSolarEntriesToFuture(entries: RawSolarEntry[], nowMs: number = Date.now()): RawSolarEntry[] {
  // Keep only solar slots that still contribute energy and proportionally scale the ongoing slot.
  return entries.reduce<RawSolarEntry[]>((acc, entry) => {
    const trimmed = trimSolarEntry(entry, nowMs);
    if (trimmed) {
      acc.push(trimmed);
    }
    return acc;
  }, []);
}

interface SlotWindow {
  startMs: number;
  endMs: number;
}

function trimForecastEntry(entry: RawForecastEntry, nowMs: number): RawForecastEntry | null {
  const window = resolveForecastWindow(entry);
  if (!window) {
    return null;
  }
  const {startMs, endMs} = window;
  if (endMs <= nowMs) {
    return null;
  }
  const adjustedStartMs = Math.max(startMs, nowMs);
  if (adjustedStartMs >= endMs) {
    return null;
  }
  const trimmed: RawForecastEntry = {...entry};
  const startIso = new Date(adjustedStartMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  trimmed.start = startIso;
  trimmed.from = startIso;
  trimmed.end = endIso;
  trimmed.to = endIso;

  const durationMs = endMs - adjustedStartMs;
  const durationHours = Number((durationMs / DEFAULT_SLOT_MS).toFixed(6));
  const durationMinutes = Number(((durationMs / DEFAULT_SLOT_MS) * 60).toFixed(3));
  trimmed.duration_hours = durationHours;
  trimmed.durationHours = durationHours;
  trimmed.duration_minutes = durationMinutes;
  trimmed.durationMinutes = durationMinutes;

  return trimmed;
}

function resolveForecastWindow(entry: RawForecastEntry): SlotWindow | null {
  const start = parseTimestamp(entry.start ?? entry.from ?? null);
  if (!start) {
    return null;
  }
  const startMs = start.getTime();
  const explicitEnd = parseTimestamp(entry.end ?? entry.to ?? null);
  let endMs: number | null =
    explicitEnd && explicitEnd.getTime() > startMs ? explicitEnd.getTime() : null;
  const durationHours = Number(entry.duration_hours ?? entry.durationHours ?? NaN);
  if (Number.isFinite(durationHours) && durationHours > 0) {
    endMs ??= startMs + durationHours * DEFAULT_SLOT_MS;
  }
  const durationMinutes = Number(entry.duration_minutes ?? entry.durationMinutes ?? NaN);
  if (Number.isFinite(durationMinutes) && durationMinutes > 0) {
    endMs ??= startMs + durationMinutes * 60 * 1000;
  }
  endMs ??= startMs + DEFAULT_SLOT_MS;
  if (endMs <= startMs) {
    return null;
  }
  return {startMs, endMs};
}

function trimSolarEntry(entry: RawSolarEntry, nowMs: number): RawSolarEntry | null {
  const window = resolveSolarWindow(entry);
  if (!window) {
    return null;
  }
  const {startMs, endMs} = window;
  if (endMs <= nowMs) {
    return null;
  }
  const adjustedStartMs = Math.max(startMs, nowMs);
  if (adjustedStartMs >= endMs) {
    return null;
  }
  const trimmed: RawSolarEntry = {...entry};
  const startIso = new Date(adjustedStartMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  trimmed.start = startIso;
  trimmed.end = endIso;
  trimmed.ts = startIso;

  const remainingRatio = (endMs - adjustedStartMs) / (endMs - startMs);
  if (typeof trimmed.energy_kwh === "number" && Number.isFinite(trimmed.energy_kwh)) {
    trimmed.energy_kwh = Number((trimmed.energy_kwh * remainingRatio).toFixed(6));
  }
  if (typeof trimmed.energy_wh === "number" && Number.isFinite(trimmed.energy_wh)) {
    trimmed.energy_wh = Number((trimmed.energy_wh * remainingRatio).toFixed(3));
  }

  return trimmed;
}

function resolveSolarWindow(entry: RawSolarEntry): SlotWindow | null {
  const start = parseTimestamp(entry.start ?? entry.ts ?? null);
  if (!start) {
    return null;
  }
  const startMs = start.getTime();
  const explicitEnd = parseTimestamp(entry.end ?? null);
  let endMs: number | null =
    explicitEnd && explicitEnd.getTime() > startMs ? explicitEnd.getTime() : null;
  endMs ??= startMs + DEFAULT_SLOT_MS;
  if (endMs <= startMs) {
    return null;
  }
  return {startMs, endMs};
}

@Injectable()
export class SimulationPreparationService {
  private readonly logger = new Logger(SimulationPreparationService.name);

  constructor(
    @Inject(SimulationConfigFactory) private readonly configFactory: SimulationConfigFactory,
    @Inject(MarketDataService) private readonly marketDataService: MarketDataService,
    @Inject(EvccDataService) private readonly evccDataService: EvccDataService,
    @Inject(ForecastAssemblyService) private readonly forecastAssembly: ForecastAssemblyService,
  ) {}

  async prepare(configFile: ConfigDocument): Promise<PreparedSimulation> {
    this.logger.log("Preparing simulation inputs from configuration document");
    const simulationConfig = this.configFactory.create(configFile);
    const warnings: string[] = [];
    const errors: string[] = [];
    const liveState: { battery_soc?: number | null } = {};

    let forecast: RawForecastEntry[] = [];
    let priceSnapshot: number | null = null;
    let solarForecast: RawSolarEntry[] = [];

    const evccResult = await this.evccDataService.collect(configFile.evcc, warnings);
    const marketResult = await this.marketDataService.collect(configFile.market_data, simulationConfig, warnings, evccResult.forecast);
    this.logger.verbose(
      `Market data fetch summary: raw_slots=${marketResult.forecast.length}, price_snapshot=${marketResult.priceSnapshot ?? "n/a"}`,
    );
    const referenceTimeMs = Date.now();
    const futureMarketForecast = trimForecastEntriesToFuture(marketResult.forecast, referenceTimeMs);
    this.logger.verbose(
      `EVCC fetch summary: raw_slots=${evccResult.forecast.length}, solar_slots=${evccResult.solarForecast.length}, battery_soc=${evccResult.batterySoc ?? "n/a"}`,
    );
    const nowIso = new Date(referenceTimeMs).toISOString();
    const futureEvccForecast = trimForecastEntriesToFuture(evccResult.forecast, referenceTimeMs);
    const futureSolarForecast = trimSolarEntriesToFuture(evccResult.solarForecast, referenceTimeMs);
    this.logger.verbose(
      `Future entry counts (ref=${nowIso}): evcc=${futureEvccForecast.length}, market=${futureMarketForecast.length}, solar=${futureSolarForecast.length}`,
    );

    // Provider order determines preference. If marketResult has data, use it; otherwise fall back to EVCC forecast later.
    if (futureMarketForecast.length) {
      forecast = [...futureMarketForecast];
      priceSnapshot = marketResult.priceSnapshot ?? priceSnapshot;
    }

    if (!forecast.length && futureEvccForecast.length) {
      forecast = [...futureEvccForecast];
    }

    if (evccResult.batterySoc !== null) {
      liveState.battery_soc = evccResult.batterySoc;
    }

    if (evccResult.priceSnapshot !== null) {
      priceSnapshot = priceSnapshot ?? evccResult.priceSnapshot;
    }

    if (futureSolarForecast.length) {
      solarForecast = futureSolarForecast;
    }

    if (!forecast.length) {
      const message =
        `Unable to retrieve a price forecast from configured sources (market_raw=${marketResult.forecast.length}, ` +
        `market_future=${futureMarketForecast.length}, evcc_raw=${evccResult.forecast.length}, evcc_future=${futureEvccForecast.length}).`;
      errors.push("Unable to retrieve a price forecast from market data endpoint.");
      this.logger.warn(message);
    }

    const forecastErasResult = this.forecastAssembly.buildForecastEras(
      forecast,
      futureEvccForecast,
      futureMarketForecast,
      futureSolarForecast,
      simulationConfig.price.grid_fee_eur_per_kwh ?? 0,
    );

    forecast = forecastErasResult.forecastEntries;

    const priceSnapshotValue = priceSnapshot ?? this.forecastAssembly.derivePriceSnapshot(forecast, simulationConfig);

    return {
      simulationConfig,
      liveState,
      forecast,
      warnings,
      errors,
      priceSnapshot: priceSnapshotValue,
      solarForecast,
      forecastEras: forecastErasResult.eras,
      liveGridPowerW: evccResult.gridPowerW,
      liveSolarPowerW: evccResult.solarPowerW,
      liveHomePowerW: evccResult.homePowerW,
      intervalSeconds: this.configFactory.getIntervalSeconds(simulationConfig),
    };
  }

}
