import { argv, exit } from "node:process";

import type {
  DemandForecastEntry,
  ForecastEra,
  HistoryPoint,
  RawForecastEntry,
  RawSolarEntry,
} from "@chargecaster/domain";

import { ConfigFileService } from "../src/config/config-file.service";
import { DemandForecastService } from "../src/config/demand-forecast.service";
import { ForecastAssemblyService } from "../src/config/forecast-assembly.service";
import type { ConfigDocument } from "../src/config/schemas";
import { SimulationConfigFactory } from "../src/config/simulation-config.factory";
import { SimulationService } from "../src/simulation/simulation.service";
import { LoadForecastArtifactService } from "../src/forecasting/load-forecast-artifact.service";
import { LoadForecastInferenceService } from "../src/forecasting/load-forecast-inference.service";
import { StorageService, type HistoryDayStatRecord } from "../src/storage/storage.service";
import { WeatherService } from "../src/config/weather.service";

type Options = {
  configPath: string;
  dbPath: string;
  modelDir: string;
  days: number;
  horizonHours: number;
};

type HourBucket = {
  hourUtc: string;
  startIso: string;
  endIso: string;
  homePowerW: number;
  solarPowerW: number;
  priceEurPerKwh: number;
};

type ReplayWindow = {
  date: string;
  history: HistoryPoint[];
  hours: HourBucket[];
  liveSocPercent: number | null;
};

type WindowResult = {
  date: string;
  candidateCost: number;
  hybridCost: number;
  costDelta: number;
  mae: number;
  p90EconomicHoursAbsoluteError: number;
  modeSwitchCount: number;
  modeSwitchDelta: number;
};

function parseArgs(rawArgs: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < rawArgs.length; index += 1) {
    const key = rawArgs[index];
    const value = rawArgs[index + 1];
    if (!key?.startsWith("--") || value == null) {
      continue;
    }
    values.set(key.slice(2), value);
    index += 1;
  }

  const configPath = values.get("config");
  const dbPath = values.get("db");
  const modelDir = values.get("model-dir");
  if (!configPath || !dbPath || !modelDir) {
    throw new Error("Expected --config, --db, and --model-dir");
  }

  return {
    configPath,
    dbPath,
    modelDir,
    days: Math.max(1, Number(values.get("days") ?? "14")),
    horizonHours: Math.max(1, Number(values.get("horizon-hours") ?? "24")),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(argv.slice(2));
  process.env.CHARGECASTER_STORAGE_PATH = options.dbPath;
  process.env.CHARGECASTER_CONFIG = options.configPath;

  const storage = new StorageService();
  try {
    const configService = new ConfigFileService();
    const baseConfig = await configService.loadDocument(options.configPath);
    const candidateConfig: ConfigDocument = {
      ...baseConfig,
      load_forecast: {
        ...(baseConfig.load_forecast ?? {}),
        model_dir: options.modelDir,
      },
    };
    const hybridConfig: ConfigDocument = {
      ...baseConfig,
      load_forecast: {
        ...(baseConfig.load_forecast ?? {}),
        model_dir: `${options.modelDir}/__missing_hybrid_baseline__`,
      },
    };

    const forecastAssembly = new ForecastAssemblyService();
    const configFactory = new SimulationConfigFactory();
    const weatherService = new WeatherService(storage);
    const artifactService = new LoadForecastArtifactService();
    const inferenceService = new LoadForecastInferenceService(artifactService);
    const demandForecastService = new DemandForecastService(storage, weatherService, inferenceService);
    const simulationService = new SimulationService(createReplaySimulationStorage());

    const windows = loadReplayWindows(storage, options.days, options.horizonHours);
    if (!windows.length) {
      throw new Error("No complete historical replay windows found");
    }

    const simulationConfig = configFactory.create(candidateConfig);
    const results: WindowResult[] = [];

    for (const window of windows) {
      const actualHours = window.hours;
      const forecast = buildRawForecast(actualHours);
      const solarForecast = buildRawSolar(actualHours);
      const { eras } = forecastAssembly.buildForecastEras(
        forecast,
        forecast,
        forecast,
        solarForecast,
        simulationConfig.price.grid_fee_eur_per_kwh ?? 0,
      );

      const candidateDemandForecast = await demandForecastService.buildForecast({
        config: candidateConfig,
        forecastEras: eras,
        liveHomePowerW: window.history[0]?.home_power_w ?? null,
      });
      const hybridDemandForecast = await demandForecastService.buildForecast({
        config: hybridConfig,
        forecastEras: eras,
        liveHomePowerW: window.history[0]?.home_power_w ?? null,
      });

      const candidateSnapshot = simulationService.runSimulation({
        config: simulationConfig,
        liveState: { battery_soc: window.liveSocPercent },
        forecast,
        solarForecast,
        forecastEras: eras,
        demandForecast: candidateDemandForecast,
      });
      const hybridSnapshot = simulationService.runSimulation({
        config: simulationConfig,
        liveState: { battery_soc: window.liveSocPercent },
        forecast,
        solarForecast,
        forecastEras: eras,
        demandForecast: hybridDemandForecast,
      });

      const candidateCost = candidateSnapshot.projected_cost_eur ?? Number.NaN;
      const hybridCost = hybridSnapshot.projected_cost_eur ?? Number.NaN;
      if (!Number.isFinite(candidateCost) || !Number.isFinite(hybridCost)) {
        throw new Error(`Replay window ${window.date} produced non-finite cost`);
      }

      const mae = meanAbsoluteError(candidateDemandForecast, actualHours);
      const p90EconomicHoursAbsoluteError = computeEconomicP90(candidateDemandForecast, actualHours);
      const modeSwitchCount = countModeSwitches(candidateSnapshot.oracle_entries);
      const hybridModeSwitchCount = countModeSwitches(hybridSnapshot.oracle_entries);

      results.push({
        date: window.date,
        candidateCost,
        hybridCost,
        costDelta: candidateCost - hybridCost,
        mae,
        p90EconomicHoursAbsoluteError,
        modeSwitchCount,
        modeSwitchDelta: modeSwitchCount - hybridModeSwitchCount,
      });
    }

    const avgCandidateCost = average(results.map((entry) => entry.candidateCost));
    const avgHybridCost = average(results.map((entry) => entry.hybridCost));
    const costDelta = average(results.map((entry) => entry.costDelta));
    const mae = average(results.map((entry) => entry.mae));
    const p90EconomicHoursAbsoluteError = average(results.map((entry) => entry.p90EconomicHoursAbsoluteError));
    const modeSwitchCount = average(results.map((entry) => entry.modeSwitchCount));
    const modeSwitchDelta = average(results.map((entry) => entry.modeSwitchDelta));

    console.log(`Replay windows: ${results.length}`);
    console.log(`Average candidate projected cost: ${avgCandidateCost.toFixed(6)} EUR`);
    console.log(`Average hybrid projected cost:    ${avgHybridCost.toFixed(6)} EUR`);
    console.log(`Average cost delta:               ${costDelta.toFixed(6)} EUR`);
    console.log(`Average MAE:                      ${mae.toFixed(3)} W`);
    console.log(`Average p90 economic error:       ${p90EconomicHoursAbsoluteError.toFixed(3)} W`);
    console.log(`Average mode switches:            ${modeSwitchCount.toFixed(3)}`);
    console.log(`Average mode switch delta:        ${modeSwitchDelta.toFixed(3)}`);

    console.log(`METRIC cost_delta_eur=${costDelta.toFixed(6)}`);
    console.log(`METRIC mae=${mae.toFixed(6)}`);
    console.log(`METRIC p90_economic_hours_absolute_error=${p90EconomicHoursAbsoluteError.toFixed(6)}`);
    console.log(`METRIC mode_switch_count=${modeSwitchCount.toFixed(6)}`);
    console.log(`METRIC mode_switch_delta=${modeSwitchDelta.toFixed(6)}`);
  } finally {
    storage.onModuleDestroy();
  }
}

function loadReplayWindows(storage: StorageService, days: number, horizonHours: number): ReplayWindow[] {
  const today = new Date().toISOString().slice(0, 10);
  const completeDays = storage
    .listHistoryDayStatsBefore(today)
    .filter(isCompleteUtcDayStat)
    .slice(0, days)
    .map((entry) => entry.date)
    .sort();

  const windows: ReplayWindow[] = [];
  for (const date of completeDays) {
    const startIso = `${date}T00:00:00.000Z`;
    const end = new Date(startIso);
    end.setUTCHours(end.getUTCHours() + horizonHours);
    const history = storage.listHistoryRangeAsc(startIso, end.toISOString()).map((record) => record.payload);
    const hours = aggregateHistoryByHour(history).slice(0, horizonHours);
    if (hours.length < Math.min(horizonHours, 12)) {
      continue;
    }
    windows.push({
      date,
      history,
      hours,
      liveSocPercent: history[0]?.battery_soc_percent ?? null,
    });
  }
  return windows;
}

function isCompleteUtcDayStat(stat: HistoryDayStatRecord): boolean {
  if (stat.pointCount < 2) {
    return false;
  }

  const dayStart = new Date(`${stat.date}T00:00:00Z`).getTime();
  const dayEnd = dayStart + 24 * 3_600_000;
  const firstPoint = new Date(stat.firstTimestamp).getTime();
  const lastPoint = new Date(stat.lastTimestamp).getTime();
  const boundaryToleranceMs = 2 * 3_600_000;

  return firstPoint - dayStart <= boundaryToleranceMs && dayEnd - lastPoint <= boundaryToleranceMs;
}

function aggregateHistoryByHour(history: HistoryPoint[]): HourBucket[] {
  const buckets = new Map<string, {
    startIso: string;
    endIso: string;
    count: number;
    homeSum: number;
    solarSum: number;
    priceSum: number;
  }>();

  for (const point of history) {
    const timestamp = new Date(point.timestamp);
    const hourStart = new Date(Date.UTC(
      timestamp.getUTCFullYear(),
      timestamp.getUTCMonth(),
      timestamp.getUTCDate(),
      timestamp.getUTCHours(),
      0,
      0,
      0,
    ));
    const hourUtc = hourStart.toISOString();
    let bucket = buckets.get(hourUtc);
    if (!bucket) {
      bucket = {
        startIso: hourUtc,
        endIso: new Date(hourStart.getTime() + 3_600_000).toISOString(),
        count: 0,
        homeSum: 0,
        solarSum: 0,
        priceSum: 0,
      };
      buckets.set(hourUtc, bucket);
    }
    bucket.count += 1;
    bucket.homeSum += point.home_power_w ?? 0;
    bucket.solarSum += Math.max(0, point.solar_power_w ?? 0);
    bucket.priceSum += point.price_eur_per_kwh ?? 0;
  }

  return [...buckets.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hourUtc, bucket]) => ({
      hourUtc,
      startIso: bucket.startIso,
      endIso: bucket.endIso,
      homePowerW: bucket.homeSum / Math.max(1, bucket.count),
      solarPowerW: bucket.solarSum / Math.max(1, bucket.count),
      priceEurPerKwh: bucket.priceSum / Math.max(1, bucket.count),
    }));
}

function buildRawForecast(hours: HourBucket[]): RawForecastEntry[] {
  return hours.map((hour, index) => ({
    start: hour.startIso,
    end: hour.endIso,
    duration_hours: 1,
    price: hour.priceEurPerKwh,
    price_ct_per_kwh: hour.priceEurPerKwh * 100,
    price_with_fee_eur_per_kwh: hour.priceEurPerKwh,
    price_with_fee_ct_per_kwh: hour.priceEurPerKwh * 100,
    unit: "EUR/kWh",
    era_id: `replay-era-${index}`,
  }));
}

function buildRawSolar(hours: HourBucket[]): RawSolarEntry[] {
  return hours.map((hour) => ({
    start: hour.startIso,
    end: hour.endIso,
    energy_wh: hour.solarPowerW,
    energy_kwh: hour.solarPowerW / 1000,
    average_power_w: hour.solarPowerW,
    provider: "historical_replay",
  }));
}

function meanAbsoluteError(forecast: DemandForecastEntry[], actualHours: HourBucket[]): number {
  const actualByStart = new Map(actualHours.map((entry) => [entry.startIso, entry.homePowerW]));
  const errors = forecast
    .map((entry) => {
      const actual = actualByStart.get(entry.start);
      return actual == null ? null : Math.abs(actual - entry.house_power_w);
    })
    .filter((value): value is number => value != null && Number.isFinite(value));
  return average(errors);
}

function computeEconomicP90(forecast: DemandForecastEntry[], actualHours: HourBucket[]): number {
  const actualByStart = new Map(actualHours.map((entry) => [entry.startIso, entry]));
  const prices = actualHours.slice(0, 24).map((entry) => entry.priceEurPerKwh).sort((left, right) => left - right);
  const threshold = prices.length
    ? prices[Math.min(prices.length - 1, Math.round((prices.length - 1) * 0.75))]
    : 0;
  const errors = forecast
    .map((entry) => {
      const actual = actualByStart.get(entry.start);
      if (!actual) {
        return null;
      }
      if (actual.solarPowerW < 500 && actual.priceEurPerKwh < threshold) {
        return null;
      }
      return Math.abs(actual.homePowerW - entry.house_power_w);
    })
    .filter((value): value is number => value != null && Number.isFinite(value))
    .sort((left, right) => left - right);

  if (!errors.length) {
    return 0;
  }
  const index = Math.min(errors.length - 1, Math.round((errors.length - 1) * 0.9));
  return errors[index] ?? 0;
}

function countModeSwitches(entries: Array<{ strategy: string }>): number {
  let previous: string | null = null;
  let switches = 0;
  for (const entry of entries) {
    const strategy = entry.strategy;
    if (previous !== null && strategy !== previous) {
      switches += 1;
    }
    previous = strategy;
  }
  return switches;
}

function average(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function createReplaySimulationStorage(): StorageService {
  const history: HistoryPoint[] = [];
  return {
    replaceSnapshot: () => undefined,
    appendHistory: (entries: HistoryPoint[]) => {
      history.push(...entries);
    },
    listHistory: (limit = 96) =>
      history
        .slice(-limit)
        .reverse()
        .map((payload, index) => ({
          id: index + 1,
          timestamp: payload.timestamp,
          payload,
        })),
    getLatestSnapshot: () => null,
  } as unknown as StorageService;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  exit(1);
});
