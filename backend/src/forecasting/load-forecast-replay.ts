import type {
  DemandForecastEntry,
  HistoryPoint,
  RawForecastEntry,
  RawSolarEntry,
} from "@chargecaster/domain";
import { Percentage } from "@chargecaster/domain";

import { DemandForecastService } from "../config/demand-forecast.service";
import { ForecastAssemblyService } from "../config/forecast-assembly.service";
import type { ConfigDocument } from "../config/schemas";
import { SimulationConfigFactory } from "../config/simulation-config.factory";
import type { WeatherLocation, WeatherService } from "../config/weather.service";
import { LoadForecastArtifactService } from "./load-forecast-artifact.service";
import { LoadForecastInferenceService } from "./load-forecast-inference.service";
import { BatteryEfficiencyService } from "../simulation/battery-efficiency.service";
import { SimulationService } from "../simulation/simulation.service";
import { StorageService, type HistoryDayStatRecord } from "../storage/storage.service";

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
  startIso: string;
  endIso: string;
  historyBeforeStart: HistoryPoint[];
  hours: HourBucket[];
  liveSocPercent: number | null;
  liveHomePowerW: number | null;
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

export interface LoadForecastReplayEvaluationOptions {
  config: ConfigDocument;
  storage: StorageService;
  versionDir: string;
  days?: number;
  horizonHours?: number;
}

export interface LoadForecastReplaySummary {
  window_count: number;
  cost_delta_eur: number;
  mae: number;
  p90_economic_hours_absolute_error: number;
  mode_switch_count: number;
  mode_switch_delta: number;
}

export async function evaluateAndPersistLoadForecastReplay(
  options: LoadForecastReplayEvaluationOptions,
): Promise<LoadForecastReplaySummary> {
  const summary = await evaluateLoadForecastReplay(options);
  const artifactService = new LoadForecastArtifactService();
  artifactService.updateReplayMetrics(options.versionDir, summary);
  artifactService.updatePromotionDecision(options.versionDir, "replay_evaluated");
  return summary;
}

export async function evaluateLoadForecastReplay(
  options: LoadForecastReplayEvaluationOptions,
): Promise<LoadForecastReplaySummary> {
  const days = Math.max(1, options.days ?? 14);
  const horizonHours = Math.max(1, options.horizonHours ?? 24);
  const artifactService = new LoadForecastArtifactService();
  const candidateInspection = artifactService.inspectVersionArtifact(options.config, options.versionDir);
  if (!candidateInspection.artifact) {
    throw new Error(`Candidate artifact is not usable for replay evaluation (${candidateInspection.reason})`);
  }

  const weatherLocation = resolveWeatherLocation(options.config);
  const windows = loadReplayWindows(options.storage, days, horizonHours);
  if (!windows.length) {
    throw new Error("No complete historical replay windows found");
  }

  const forecastAssembly = new ForecastAssemblyService();
  const configFactory = new SimulationConfigFactory();
  const candidateInferenceService = new LoadForecastInferenceService(artifactService);
  const simulationConfig = configFactory.create(options.config);
  const results: WindowResult[] = [];

  for (const window of windows) {
    const replayStorage = createReplayStorage(window.historyBeforeStart);
    const replayWeatherService = createReplayWeatherService(options.storage, weatherLocation);
    const candidateDemandForecastService = new DemandForecastService(
      replayStorage as StorageService,
      replayWeatherService as WeatherService,
      {
        inspectActiveArtifact: () => candidateInspection,
        getRuntimeAvailability: () => candidateInferenceService.getRuntimeAvailability(),
        predict: async (_config: ConfigDocument, floatFeatures: number[][]) => {
          const prediction = await candidateInferenceService.predictWithArtifact(candidateInspection.artifact!, floatFeatures);
          if (!prediction) {
            throw new Error("CatBoost runtime unavailable during replay evaluation");
          }
          return prediction;
        },
      } as unknown as LoadForecastInferenceService,
    );
    const hybridDemandForecastService = new DemandForecastService(
      replayStorage as StorageService,
      replayWeatherService as WeatherService,
      {
        inspectActiveArtifact: () => ({ artifact: null, reason: "no_artifact" as const }),
        getRuntimeAvailability: () => ({ available: null, lastError: null }),
        predict: async () => null,
      } as unknown as LoadForecastInferenceService,
    );
    const simulationService = new SimulationService(
      createReplaySimulationStorage(),
      createReplayBatteryEfficiencyService() as BatteryEfficiencyService,
    );

    const forecast = buildRawForecast(window.hours);
    const solarForecast = buildRawSolar(window.hours);
    const { eras } = forecastAssembly.buildForecastEras(
      forecast,
      [{ key: "awattar", priority: 1, forecast }],
      solarForecast,
      simulationConfig.price.grid_fee_eur_per_kwh ?? 0,
    );

    const candidateDemandForecast = await candidateDemandForecastService.buildForecast({
      config: options.config,
      forecastEras: eras,
      liveHomePowerW: window.liveHomePowerW,
    });
    const hybridDemandForecast = await hybridDemandForecastService.buildForecast({
      config: options.config,
      forecastEras: eras,
      liveHomePowerW: window.liveHomePowerW,
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

    const mae = meanAbsoluteError(candidateDemandForecast, window.hours);
    const p90EconomicHoursAbsoluteError = computeEconomicP90(candidateDemandForecast, window.hours);
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

  return {
    window_count: results.length,
    cost_delta_eur: average(results.map((entry) => entry.costDelta)),
    mae: average(results.map((entry) => entry.mae)),
    p90_economic_hours_absolute_error: average(results.map((entry) => entry.p90EconomicHoursAbsoluteError)),
    mode_switch_count: average(results.map((entry) => entry.modeSwitchCount)),
    mode_switch_delta: average(results.map((entry) => entry.modeSwitchDelta)),
  };
}

function loadReplayWindows(storage: StorageService, days: number, horizonHours: number): ReplayWindow[] {
  const today = new Date().toISOString().slice(0, 10);
  const completeDays = storage
    .listHistoryDayStatsBefore(today)
    .filter(isCompleteUtcDayStat)
    .slice(0, days)
    .map((entry) => entry.date)
    .sort();
  const allHistory = storage.listAllHistoryAsc().map((record) => record.payload);

  const windows: ReplayWindow[] = [];
  let historyCursor = 0;
  for (const date of completeDays) {
    const startIso = `${date}T00:00:00.000Z`;
    while (historyCursor < allHistory.length && allHistory[historyCursor]!.timestamp < startIso) {
      historyCursor += 1;
    }
    const end = new Date(startIso);
    end.setUTCHours(end.getUTCHours() + horizonHours);
    const endIso = end.toISOString();
    const futureHistory = storage.listHistoryRangeAsc(startIso, endIso).map((record) => record.payload);
    const hours = aggregateHistoryByHour(futureHistory).slice(0, horizonHours);
    if (hours.length < Math.min(horizonHours, 12)) {
      continue;
    }
    const historyBeforeStart = allHistory.slice(0, historyCursor);
    const latestHistoryPoint = historyBeforeStart.at(-1) ?? null;
    windows.push({
      date,
      startIso,
      endIso,
      historyBeforeStart,
      hours,
      liveSocPercent: latestHistoryPoint?.battery_soc_percent ?? null,
      liveHomePowerW: latestHistoryPoint?.home_power_w ?? null,
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
    const bucket = buckets.get(hourUtc) ?? {
      startIso: hourUtc,
      endIso: new Date(hourStart.getTime() + 3_600_000).toISOString(),
      count: 0,
      homeSum: 0,
      solarSum: 0,
      priceSum: 0,
    };
    bucket.count += 1;
    bucket.homeSum += point.home_power_w ?? 0;
    bucket.solarSum += Math.max(0, point.solar_power_w ?? 0);
    bucket.priceSum += point.price_eur_per_kwh ?? 0;
    buckets.set(hourUtc, bucket);
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
    if (previous !== null && entry.strategy !== previous) {
      switches += 1;
    }
    previous = entry.strategy;
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

function createReplayBatteryEfficiencyService(): Partial<BatteryEfficiencyService> {
  return {
    estimateRecentEfficiencies: () => ({
      chargeEfficiency: Percentage.fromRatio(0.95),
      dischargeEfficiency: Percentage.fromRatio(0.95),
      chargeAverageCRate: 0.25,
      dischargeAverageCRate: 0.25,
      chargeRuns: 0,
      dischargeRuns: 0,
      source: "fallback" as const,
    }),
  };
}

function createReplayStorage(historyBeforeStart: HistoryPoint[]): Partial<StorageService> {
  return {
    listAllHistoryAsc: () =>
      historyBeforeStart.map((payload, index) => ({
        id: index + 1,
        timestamp: payload.timestamp,
        payload,
      })),
  };
}

function createReplayWeatherService(storage: StorageService, location: WeatherLocation | null): Partial<WeatherService> {
  return {
    getWeatherHours: async (_location: WeatherLocation, startInclusive: Date, endInclusive: Date) => {
      if (!location) {
        return [];
      }
      return storage.listWeatherHours(
        location.latitude,
        location.longitude,
        floorToUtcHour(startInclusive).toISOString(),
        floorToUtcHour(endInclusive).toISOString(),
      );
    },
  };
}

function resolveWeatherLocation(config: ConfigDocument): WeatherLocation | null {
  const latitude = config.location?.latitude;
  const longitude = config.location?.longitude;
  if (typeof latitude !== "number" || typeof longitude !== "number") {
    return null;
  }
  return {
    latitude,
    longitude,
    timezone: config.location?.timezone ?? "UTC",
  };
}

function floorToUtcHour(date: Date): Date {
  return new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    0,
    0,
    0,
  ));
}
