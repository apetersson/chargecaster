import { Inject, Injectable, Logger } from "@nestjs/common";

import type { ForecastEra, RawForecastEntry, RawSolarEntry, SimulationConfig } from "@chargecaster/domain";
import type { ConfigDocument } from "./schemas";
import { parseTimestamp } from "../simulation/solar";
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
    const simulationConfig = this.configFactory.create(configFile);
    const warnings: string[] = [];
    const errors: string[] = [];
    const liveState: { battery_soc?: number | null } = {};

    let forecast: RawForecastEntry[] = [];
    let priceSnapshot: number | null = null;
    let solarForecast: RawSolarEntry[] = [];

    const evccResult = await this.evccDataService.collect(configFile.evcc, warnings);
    const marketResult = await this.marketDataService.collect(configFile.market_data, simulationConfig, warnings, evccResult.forecast);
    this.logger.log(
      `Market data fetch summary: raw_slots=${marketResult.forecast.length}, price_snapshot=${marketResult.priceSnapshot ?? "n/a"}`,
    );
    const futureMarketForecast = this.filterFutureForecastEntries(marketResult.forecast);
    this.logger.log(
      `EVCC fetch summary: raw_slots=${evccResult.forecast.length}, solar_slots=${evccResult.solarForecast.length}, battery_soc=${evccResult.batterySoc ?? "n/a"}`,
    );
    const nowIso = new Date().toISOString();
    const futureEvccForecast = this.filterFutureForecastEntries(evccResult.forecast);
    const futureSolarForecast = this.filterFutureSolarEntries(evccResult.solarForecast);
    this.logger.log(
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

  private filterFutureForecastEntries(entries: RawForecastEntry[]): RawForecastEntry[] {
    const now = Date.now();
    return entries.filter((entry) => {
      const start = parseTimestamp(entry.start ?? entry.from ?? null);
      if (!start) {
        return false;
      }
      return start.getTime() > now;
    });
  }

  private filterFutureSolarEntries(entries: RawSolarEntry[]): RawSolarEntry[] {
    const now = Date.now();
    return entries.filter((entry) => {
      const start = parseTimestamp(entry.start ?? entry.ts ?? null);
      if (!start) {
        return false;
      }
      return start.getTime() > now;
    });
  }
}
