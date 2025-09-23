import { Inject, Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";

import { normalizePriceSlots, SimulationService } from "../simulation/simulation.service";
import { FroniusService } from "../fronius/fronius.service";
import type { ForecastEra, RawForecastEntry, RawSolarEntry, SimulationConfig } from "../simulation/types";
import { buildSolarForecastFromTimeseries, parseTimestamp } from "../simulation/solar";
import type { ConfigDocument } from "./schemas";
import { parseConfigDocument, parseEvccState, parseMarketForecast } from "./schemas";

const DEFAULT_CONFIG_FILE = "../config.local.yaml";
const DEFAULT_MARKET_DATA_URL = "https://api.awattar.de/v1/marketdata";
const REQUEST_TIMEOUT_MS = 15000;
const SLOT_DURATION_MS = 3_600_000;

type MutableRecord = Record<string, unknown>;

type EvccConfig = ConfigDocument["evcc"];
type MarketConfig = ConfigDocument["market_data"];

interface PreparedSimulation {
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
}

interface NormalizedSlot {
  payload: MutableRecord;
  startDate: Date | null;
  endDate: Date | null;
  startIso: string | null;
  endIso: string | null;
  durationHours: number | null;
}

type ForecastCostPayload = MutableRecord & {
  price?: unknown;
  value?: unknown;
  unit?: unknown;
  price_unit?: unknown;
  value_unit?: unknown;
  price_ct_per_kwh?: number | null;
};

@Injectable()
export class ConfigSyncService implements OnModuleDestroy {
  private readonly logger = new Logger(ConfigSyncService.name);
  private schedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private runInProgress = false;
  private intervalSeconds: number | null = null;

  constructor(
    @Inject(SimulationService) private readonly simulationService: SimulationService,
    @Inject(FroniusService) private readonly froniusService: FroniusService,
  ) {
  }

  async seedFromConfig(): Promise<void> {
    if (this.runInProgress) {
      this.logger.warn("Simulation already running; skipping new request.");
      return;
    }
    this.runInProgress = true;
    const configPath = this.resolveConfigPath();
    try {
      const rawConfig = await this.loadConfigFile(configPath);

      this.logger.log(`Loaded configuration from ${configPath}`);

      this.logger.log("Preparing simulation inputs from configured data sources...");
      const dryRun = rawConfig.dry_run ?? false;
      const prepared = await this.prepareSimulation(rawConfig);

      if (!prepared.forecast.length) {
        const message = "No forecast data could be obtained from configured sources.";
        prepared.errors.push(message);
        this.logger.error(message);
        throw new Error(message);
      }

      this.logger.log(
        `Running simulation with ${prepared.forecast.length} forecast slots; live SOC: ${
          prepared.liveState.battery_soc ?? "n/a"
        }`,
      );
      const snapshot = this.simulationService.runSimulation({
        config: prepared.simulationConfig,
        liveState: prepared.liveState,
        forecast: prepared.forecast,
        solarForecast: prepared.solarForecast,
        forecastEras: prepared.forecastEras,
        warnings: prepared.warnings,
        errors: prepared.errors,
        priceSnapshotEurPerKwh: prepared.priceSnapshot,
        observations: {
          gridPowerW: prepared.liveGridPowerW,
          solarPowerW: prepared.liveSolarPowerW,
        },
      });
      this.logger.log("Seeded snapshot using config data.");
      if (dryRun) {
        this.logger.log("Dry run enabled; skipping Fronius optimization apply.");
      } else {
        await this.froniusService.applyOptimization(rawConfig, snapshot);
      }
    } catch (error) {
      this.logger.error(`Config sync failed: ${this.describeError(error)}`);
      throw error;
    } finally {
      this.runInProgress = false;
      this.scheduleNextRun();
    }
  }

  onModuleDestroy(): void {
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }

  private resolveConfigPath(): string {
    const override = process.env.BATTERYCTL_CONFIG;
    if (override && override.trim().length > 0) {
      return resolve(process.cwd(), override.trim());
    }
    return resolve(process.cwd(), DEFAULT_CONFIG_FILE);
  }

  private async loadConfigFile(path: string): Promise<ConfigDocument> {
    try {
      await access(path, fsConstants.R_OK);
    } catch (error) {
      throw new Error(`Config file not accessible at ${path}: ${this.describeError(error)}`);
    }

    const rawContent = await readFile(path, "utf-8");
    const parsed: unknown = YAML.parse(rawContent);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Config file is empty or invalid");
    }
    return parseConfigDocument(parsed);
  }

  private async prepareSimulation(configFile: ConfigDocument): Promise<PreparedSimulation> {
    const simulationConfig = this.buildSimulationConfig(configFile);
    const warnings: string[] = [];
    const errors: string[] = [];
    const liveState: { battery_soc?: number | null } = {};

    let forecast: RawForecastEntry[] = [];
    let priceSnapshot: number | null = null;
    let solarForecast: RawSolarEntry[] = [];

    const marketResult = await this.collectFromMarket(configFile.market_data, simulationConfig, warnings);
    this.logger.log(
      `Market data fetch summary: raw_slots=${marketResult.forecast.length}, price_snapshot=${marketResult.priceSnapshot ?? "n/a"}`,
    );
    const futureMarketForecast = this.filterFutureEntries(marketResult.forecast);

    const evccResult = await this.collectFromEvcc(configFile.evcc, warnings);
    this.logger.log(
      `EVCC fetch summary: raw_slots=${evccResult.forecast.length}, solar_slots=${evccResult.solarForecast.length}, battery_soc=${evccResult.batterySoc ?? "n/a"}`,
    );
    const nowIso = new Date().toISOString();
    const futureEvccForecast = this.filterFutureEntries(evccResult.forecast);
    const futureSolarForecast = this.filterFutureEntries(evccResult.solarForecast);
    this.logger.log(
      `Future entry counts (ref=${nowIso}): evcc=${futureEvccForecast.length}, market=${futureMarketForecast.length}, solar=${futureSolarForecast.length}`,
    );

    const preferMarket = configFile.market_data?.prefer_market ?? true;
    this.logger.log(
      `Market data: slots=${futureMarketForecast.length}, snapshot=${
        marketResult.priceSnapshot ?? "n/a"
      }, prefer_market=${preferMarket}`,
    );
    if (futureMarketForecast.length && (preferMarket || !forecast.length)) {
      forecast = [...futureMarketForecast];
      priceSnapshot = marketResult.priceSnapshot ?? priceSnapshot;
    } else if (!forecast.length && futureMarketForecast.length) {
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
        `Unable to retrieve a price forecast from market data endpoint (market_raw=${marketResult.forecast.length}, ` +
        `market_future=${futureMarketForecast.length}, evcc_raw=${evccResult.forecast.length}, evcc_future=${futureEvccForecast.length}).`;
      errors.push("Unable to retrieve a price forecast from market data endpoint.");
      this.logger.warn(message);
    }

    const useMarketForPrice = preferMarket && futureMarketForecast.length > 0;
    const canonicalForecast = useMarketForPrice
      ? futureMarketForecast
      : futureEvccForecast.length
        ? futureEvccForecast
        : forecast;

    this.logger.log(
      `Canonical forecast selection: prefer_market=${preferMarket}, using=${
        useMarketForPrice ? "market" : futureEvccForecast.length ? "evcc" : "fallback"
      }, canonical_slots=${canonicalForecast.length}`,
    );

    const gridFeeForDisplay = simulationConfig.price?.grid_fee_eur_per_kwh ?? 0;

    const {forecastEntries, eras} = this.buildForecastEras(
      canonicalForecast,
      futureEvccForecast,
      futureMarketForecast,
      solarForecast,
      gridFeeForDisplay,
    );

    forecast = forecastEntries;
    priceSnapshot = priceSnapshot ?? this.derivePriceSnapshot(forecast, simulationConfig);
    this.logger.log(
      `Prepared simulation summary: slots=${forecast.length}, price_snapshot=${priceSnapshot ?? "n/a"}`,
    );

    return {
      simulationConfig,
      liveState,
      forecast,
      solarForecast,
      forecastEras: eras,
      warnings,
      errors,
      priceSnapshot: priceSnapshot ?? null,
      liveGridPowerW: evccResult.gridPowerW,
      liveSolarPowerW: evccResult.solarPowerW,
    };
  }

  private buildSimulationConfig(configFile: ConfigDocument): SimulationConfig {
    const battery = configFile.battery ?? {};
    const price = configFile.price ?? {};
    const logic = configFile.logic ?? {};
    const solar = configFile.solar ?? {};

    const capacity = battery.capacity_kwh;
    const chargePower = battery.max_charge_power_w;
    const floorSoc = battery.auto_mode_floor_soc ?? null;

    const gridFee = price.grid_fee_eur_per_kwh ?? null;
    const feedInTariff = price.feed_in_tariff_eur_per_kwh ?? null;

    const intervalSecondsRaw = logic.interval_seconds ?? 300;
    const normalizedIntervalSeconds =
      Number.isFinite(intervalSecondsRaw) && intervalSecondsRaw > 0
        ? intervalSecondsRaw
        : null;
    this.intervalSeconds = normalizedIntervalSeconds;

    const minHoldMinutes = logic.min_hold_minutes ?? 0;
    const houseLoad = logic.house_load_w ?? 1200;
    const allowBatteryExport = logic.allow_battery_export ?? true;
    const directUseRatio = solar.direct_use_ratio ?? null;
    const maxSolarChargePower = battery.max_charge_power_solar_w ?? null;

    const normalizedCapacity = typeof capacity === "number" && Number.isFinite(capacity) ? capacity : 0;
    const normalizedChargePower = typeof chargePower === "number" && Number.isFinite(chargePower) ? chargePower : 0;
    const normalizedFloorSoc =
      typeof floorSoc === "number" && Number.isFinite(floorSoc) ? floorSoc : undefined;

    const normalizedGridFee = typeof gridFee === "number" && Number.isFinite(gridFee) ? gridFee : null;
    const normalizedFeedInTariff =
      typeof feedInTariff === "number" && Number.isFinite(feedInTariff) ? feedInTariff : null;

    const normalizedMinHold = Number.isFinite(minHoldMinutes) ? minHoldMinutes : undefined;
    const normalizedHouseLoad = Number.isFinite(houseLoad) ? houseLoad : undefined;

    const normalizedDirectUse =
      typeof directUseRatio === "number" && Number.isFinite(directUseRatio)
        ? Math.min(Math.max(directUseRatio, 0), 1)
        : null;
    const normalizedSolarPower =
      typeof maxSolarChargePower === "number" && Number.isFinite(maxSolarChargePower)
        ? Math.max(0, maxSolarChargePower)
        : null;

    return {
      battery: {
        capacity_kwh: normalizedCapacity,
        max_charge_power_w: normalizedChargePower,
        auto_mode_floor_soc: normalizedFloorSoc,
        max_charge_power_solar_w: normalizedSolarPower ?? undefined,
      },
      price: {
        grid_fee_eur_per_kwh: normalizedGridFee ?? 0,
        feed_in_tariff_eur_per_kwh: normalizedFeedInTariff ?? undefined,
      },
      logic: {
        interval_seconds: normalizedIntervalSeconds ?? undefined,
        min_hold_minutes: normalizedMinHold,
        house_load_w: normalizedHouseLoad,
        allow_battery_export: allowBatteryExport,
      },
      solar:
        normalizedDirectUse === null
          ? undefined
          : {
            direct_use_ratio: normalizedDirectUse,
          },
    };
  }

  private async collectFromEvcc(
    evccConfig: EvccConfig,
    warnings: string[],
  ): Promise<{
    forecast: RawForecastEntry[];
    solarForecast: RawSolarEntry[];
    priceSnapshot: number | null;
    batterySoc: number | null;
    gridPowerW: number | null;
    solarPowerW: number | null;
  }> {
    const enabled = evccConfig?.enabled ?? true;
    if (!enabled) {
      warnings.push("EVCC data fetch disabled in config.");
      this.logger.warn("EVCC data fetch disabled in config.");
      return {
        forecast: [],
        solarForecast: [],
        priceSnapshot: null,
        batterySoc: null,
        gridPowerW: null,
        solarPowerW: null,
      };
    }

    const baseUrl = evccConfig?.base_url;
    if (!baseUrl) {
      const message = "EVCC base_url not configured; skipping EVCC forecast.";
      warnings.push(message);
      this.logger.warn(message);
      return {
        forecast: [],
        solarForecast: [],
        priceSnapshot: null,
        batterySoc: null,
        gridPowerW: null,
        solarPowerW: null,
      };
    }

    let endpoint: string;
    try {
      endpoint = new URL("/api/state", baseUrl).toString();
    } catch (error) {
      const message = `Invalid EVCC base_url (${baseUrl}): ${this.describeError(error)}`;
      warnings.push(message);
      this.logger.warn(message);
      return {
        forecast: [],
        solarForecast: [],
        priceSnapshot: null,
        batterySoc: null,
        gridPowerW: null,
        solarPowerW: null,
      };
    }

    const timeoutMs = evccConfig?.timeout_ms ?? REQUEST_TIMEOUT_MS;
    const token = evccConfig?.token ?? null;
    const headers: Record<string, string> = {};
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    try {
      this.logger.log(`Fetching EVCC state from ${endpoint}`);
      const payload = await this.fetchJson(endpoint, timeoutMs, {
        headers: Object.keys(headers).length ? headers : undefined,
      });

      const parsed = parseEvccState(payload);
      const solarForecast = buildSolarForecastFromTimeseries(parsed.solarTimeseries);

      return {
        forecast: parsed.forecast,
        solarForecast,
        priceSnapshot: parsed.priceSnapshot,
        batterySoc: parsed.batterySoc,
        gridPowerW: parsed.gridPowerW,
        solarPowerW: parsed.solarPowerW,
      };
    } catch (error) {
      const message = `EVCC data fetch failed: ${this.describeError(error)}`;
      warnings.push(message);
      this.logger.warn(message);
      return {
        forecast: [],
        solarForecast: [],
        priceSnapshot: null,
        batterySoc: null,
        gridPowerW: null,
        solarPowerW: null,
      };
    }
  }

  private async collectFromMarket(
    marketConfig: MarketConfig,
    simulationConfig: SimulationConfig,
    warnings: string[],
  ): Promise<{ forecast: RawForecastEntry[]; priceSnapshot: number | null; solar: RawSolarEntry[] }> {
    const enabled = marketConfig?.enabled ?? true;
    const forecast: RawForecastEntry[] = [];
    let priceSnapshot: number | null = null;

    if (!enabled) {
      warnings.push("Market data fetch disabled in config.");
      this.logger.warn("Market data fetch disabled in config.");
      return {forecast, priceSnapshot, solar: []};
    }

    const endpoint = marketConfig?.url ?? DEFAULT_MARKET_DATA_URL;
    const maxHours = marketConfig?.max_hours ?? 72;

    try {
      this.logger.log(`Fetching market forecast from ${endpoint} (max ${maxHours}h)`);
      const payload = await this.fetchJson(endpoint, REQUEST_TIMEOUT_MS);
      const entries = parseMarketForecast(payload);
      forecast.push(...this.normalizeMarketEntries(entries, maxHours));
      priceSnapshot = this.derivePriceSnapshot(forecast, simulationConfig);
      if (!forecast.length) {
        warnings.push("Market data response contained no usable price slots.");
        this.logger.warn("Market data response contained no usable price slots.");
      }
    } catch (error) {
      const message = `Market data fetch failed: ${this.describeError(error)}`;
      warnings.push(message);
      this.logger.warn(message);
    }

    return {forecast, priceSnapshot, solar: []};
  }

  private normalizeMarketEntries(entries: RawForecastEntry[], maxHours = 72): RawForecastEntry[] {
    const records: RawForecastEntry[] = [];
    if (!entries.length) {
      return records;
    }

    const now = Date.now();
    const horizonEnd = now + maxHours * 3600_000;

    for (const entry of entries) {
      const startValue = (entry.start ?? entry.from) ?? null;
      const endValue = (entry.end ?? entry.to) ?? null;

      const startDate = parseTimestamp(startValue);
      if (!startDate) {
        continue;
      }

      let endDate = parseTimestamp(endValue);
      if (!endDate) {
        const durationHours = entry.duration_hours ?? entry.durationHours ?? 1;
        const normalizedDuration =
          Number.isFinite(durationHours) && durationHours > 0
            ? durationHours
            : 1;
        endDate = new Date(startDate.getTime() + normalizedDuration * 3600_000);
      }

      if (endDate.getTime() <= now) {
        continue;
      }
      if (startDate.getTime() >= horizonEnd) {
        continue;
      }

      const priceCandidate = entry.price ?? entry.value ?? entry.price_ct_per_kwh ?? entry.value_ct_per_kwh;
      const price = typeof priceCandidate === "number" && Number.isFinite(priceCandidate)
        ? priceCandidate
        : null;
      if (price === null) {
        continue;
      }

      const normalized = structuredClone(entry);
      normalized.start = startDate.toISOString();
      normalized.end = endDate.toISOString();
      normalized.price = price;
      if (!normalized.unit && (normalized.price_unit || normalized.value_unit)) {
        normalized.unit = (normalized.price_unit ?? normalized.value_unit) ?? undefined;
      }

      records.push(normalized);
    }

    return records;
  }

  private filterFutureEntries(entries: RawForecastEntry[]): RawForecastEntry[] {
    const now = Date.now();
    return entries.filter((entry) => {
      const start = parseTimestamp((entry.start ?? entry.from) ?? null);
      const end = parseTimestamp((entry.end ?? entry.to) ?? null);

      if (end && end.getTime() <= now) {
        return false;
      }
      if (!start) {
        return false;
      }
      return start.getTime() > now;
    });
  }

  private buildForecastEras(
    canonicalForecast: RawForecastEntry[],
    evccForecast: RawForecastEntry[],
    marketForecast: RawForecastEntry[],
    solarForecast: RawSolarEntry[],
    gridFeeEurPerKwh: number,
  ): { forecastEntries: RawForecastEntry[]; eras: ForecastEra[] } {
    if (!canonicalForecast.length) {
      return {forecastEntries: [], eras: []};
    }

    const canonicalSlots = this.dedupeSlots(
      canonicalForecast
        .map((entry) => this.normalizeForecastSlot(entry))
        .filter((slot) => slot.startIso !== null),
    );

    const marketIndex = this.buildStartIndex(marketForecast);

    const solarSlots = this.dedupeSlots(
      solarForecast
        .map((entry) => this.normalizeForecastSlot(entry))
        .filter((slot) => slot.startDate !== null),
    );

    const findSolarPayload = (
      startDate: Date | null,
      endDate: Date | null,
    ): MutableRecord | undefined => {
      if (!startDate) {
        return undefined;
      }
      const startIso = startDate.toISOString();
      const direct = solarSlots.find((slot) => slot.startIso === startIso);
      if (direct) {
        return this.cloneRecord(direct.payload);
      }
      const startTime = startDate.getTime();
      const endTime = endDate?.getTime() ?? startTime + SLOT_DURATION_MS;
      for (const slot of solarSlots) {
        const slotStart = slot.startDate?.getTime();
        if (slotStart === undefined) {
          continue;
        }
        const slotEnd = slot.endDate?.getTime() ?? slotStart + SLOT_DURATION_MS;
        if (slotStart < endTime && slotEnd > startTime) {
          return this.cloneRecord(slot.payload);
        }
      }
      return undefined;
    };

    interface EraEntry {
      slot: NormalizedSlot;
      payload: MutableRecord & { era_id: string };
      sources: ForecastEra["sources"];
    }

    const eraMap = new Map<string, EraEntry>();

    const addSource = (
      entry: EraEntry,
      provider: string,
      type: ForecastEra["sources"][number]["type"],
      payload: MutableRecord,
    ): void => {
      const exists = entry.sources.some((source) => source.provider === provider && source.type === type);
      if (!exists) {
        entry.sources.push({provider, type, payload: structuredClone(payload)});
      }
    };

    const sanitizedGridFeeEur = Number.isFinite(gridFeeEurPerKwh) ? Math.max(0, gridFeeEurPerKwh) : 0;
    const gridFeeCt = sanitizedGridFeeEur * 100;

    const applySlotPrice = (
      entry: EraEntry,
      rawPrice: unknown,
      rawUnit: unknown,
    ): { priceCt: number; priceEur: number; totalCt: number; totalEur: number } | null => {
      const priceCt = this.convertPriceToCents(rawPrice, rawUnit);
      if (priceCt === null) {
        return null;
      }
      const priceEur = priceCt / 100;
      const totalCt = priceCt + gridFeeCt;
      const totalEur = totalCt / 100;
      entry.slot.payload.price = priceEur;
      entry.slot.payload.unit = "EUR/kWh";
      entry.slot.payload.price_ct_per_kwh = priceCt;
      entry.slot.payload.price_with_fee_ct_per_kwh = totalCt;
      entry.slot.payload.price_with_fee_eur_per_kwh = totalEur;
      entry.payload.price = priceEur;
      entry.payload.unit = "EUR/kWh";
      entry.payload.price_ct_per_kwh = priceCt;
      entry.payload.price_with_fee_ct_per_kwh = totalCt;
      entry.payload.price_with_fee_eur_per_kwh = totalEur;
      return {
        priceCt,
        priceEur,
        totalCt,
        totalEur,
      };
    };

    for (const slot of canonicalSlots) {
      if (!slot.startIso) {
        continue;
      }
      let entry = eraMap.get(slot.startIso);
      if (!entry) {
        const eraId = randomUUID();
        entry = {
          slot,
          payload: {...slot.payload, era_id: eraId} as MutableRecord & { era_id: string },
          sources: [],
        };
        eraMap.set(slot.startIso, entry);
      }

      const rawPrice =
        slot.payload.price ??
        slot.payload.value ??
        slot.payload.price_ct_per_kwh ??
        slot.payload.value_ct_per_kwh ??
        entry.payload.price ??
        entry.payload.value;
      const rawUnit =
        slot.payload.unit ??
        slot.payload.price_unit ??
        slot.payload.value_unit ??
        (slot.payload.price_ct_per_kwh != null ? "ct/kWh" : undefined);
      const priceInfo = applySlotPrice(entry, rawPrice, rawUnit);

      const marketPayload = marketIndex.get(slot.startIso);
      if (marketPayload) {
        const cloned = this.cloneRecord(marketPayload);
        const record: ForecastCostPayload = {...cloned};
        const rawMarketPrice = record.price ?? record.value;
        const rawMarketUnit = record.unit ?? record.price_unit ?? record.value_unit;
        const priceCt = this.convertPriceToCents(rawMarketPrice, rawMarketUnit);
        if (priceCt !== null) {
          record.price_ct_per_kwh = priceCt;
          record.unit = "ct/kWh";
          const marketInfo = applySlotPrice(entry, priceCt / 100, "EUR/kWh");
          if (marketInfo) {
            record.price_with_fee_ct_per_kwh = marketInfo.totalCt;
            record.price_with_fee_eur_per_kwh = marketInfo.totalEur;
          }
        } else if (priceInfo) {
          record.price_with_fee_ct_per_kwh = priceInfo.totalCt;
          record.price_with_fee_eur_per_kwh = priceInfo.totalEur;
        }
        addSource(entry, "awattar", "cost", record);
      }

      const solarPayload = findSolarPayload(slot.startDate, slot.endDate);
      if (solarPayload) {
        addSource(entry, "solar", "solar", this.cloneRecord(solarPayload));
      }
    }

    const sortedEntries = [...eraMap.values()].sort((a, b) => {
      const aTime = a.slot.startDate?.getTime() ?? 0;
      const bTime = b.slot.startDate?.getTime() ?? 0;
      return aTime - bTime;
    });

    const forecastEntries = sortedEntries.map((entry) => structuredClone(entry.payload) as RawForecastEntry);
    const eras = sortedEntries.map((entry) => ({
      era_id: entry.payload.era_id,
      start: entry.slot.startIso ?? undefined,
      end: entry.slot.endIso ?? undefined,
      duration_hours: entry.slot.durationHours,
      sources: entry.sources,
    }));
    const deduped = this.dedupeErasAndEntries(forecastEntries, eras);
    return this.trimForecastByPriceCoverage(deduped.forecastEntries, deduped.eras);
  }

  private buildStartIndex(entries: RawForecastEntry[]): Map<string, MutableRecord> {
    const index = new Map<string, MutableRecord>();
    for (const entry of entries) {
      const slot = this.normalizeForecastSlot(entry);
      if (!slot.startIso) {
        continue;
      }
      index.set(slot.startIso, slot.payload);
    }
    return index;
  }

  private normalizeForecastSlot(entry: RawForecastEntry): NormalizedSlot {
    const payload = structuredClone(entry) as MutableRecord;
    const startDate = parseTimestamp(payload.start ?? payload.from);
    const endDateCandidate = parseTimestamp(payload.end ?? payload.to);
    const endDate =
      endDateCandidate ?? (startDate ? new Date(startDate.getTime() + SLOT_DURATION_MS) : null);
    const startIso = startDate ? startDate.toISOString() : null;
    const endIso = endDate ? endDate.toISOString() : null;
    if (startIso) {
      payload.start = startIso;
    }
    if (endIso) {
      payload.end = endIso;
    }
    const durationHours =
      startDate && endDate ? (endDate.getTime() - startDate.getTime()) / 3600_000 : null;

    return {
      payload,
      startDate,
      endDate,
      startIso,
      endIso,
      durationHours,
    };
  }

  private dedupeSlots(slots: NormalizedSlot[]): NormalizedSlot[] {
    const map = new Map<string, NormalizedSlot>();
    for (const slot of slots) {
      const key = slot.startIso ?? "";
      if (!map.has(key)) {
        map.set(key, slot);
      }
    }
    return [...map.values()].sort((a, b) => {
      const aTime = a.startDate?.getTime() ?? 0;
      const bTime = b.startDate?.getTime() ?? 0;
      return aTime - bTime;
    });
  }

  private dedupeErasAndEntries(
    entries: RawForecastEntry[],
    eras: ForecastEra[],
  ): { forecastEntries: RawForecastEntry[]; eras: ForecastEra[] } {
    const map = new Map<string, { entry: MutableRecord; era: ForecastEra }>();

    for (let index = 0; index < eras.length; index += 1) {
      const era = eras[index];
      const entry = (entries[index] as MutableRecord | undefined) ?? {};
      const start = typeof era.start === "string" ? era.start : null;
      if (!start) {
        const key = `__unknown_${index}`;
        map.set(key, {entry, era});
        continue;
      }

      const existing = map.get(start);
      if (!existing) {
        map.set(start, {
          entry,
          era: {
            ...era,
            sources: [...era.sources],
          },
        });
        continue;
      }

      this.mergeSources(existing.era.sources, era.sources);
    }

    const sorted = [...map.entries()].sort((a, b) => {
      const aStart = parseTimestamp(a[0])?.getTime() ?? 0;
      const bStart = parseTimestamp(b[0])?.getTime() ?? 0;
      return aStart - bStart;
    });

    const dedupedEntries: RawForecastEntry[] = [];
    const dedupedEras: ForecastEra[] = [];
    for (const [, value] of sorted) {
      dedupedEntries.push(structuredClone(value.entry) as RawForecastEntry);
      dedupedEras.push(structuredClone(value.era));
    }

    return {forecastEntries: dedupedEntries, eras: dedupedEras};
  }

  private mergeSources(target: ForecastEra["sources"], incoming: ForecastEra["sources"]): void {
    for (const source of incoming) {
      const exists = target.find((item) => item.provider === source.provider && item.type === source.type);
      if (!exists) {
        target.push({provider: source.provider, type: source.type, payload: structuredClone(source.payload)});
        continue;
      }
      if (!exists.payload || Object.keys(exists.payload).length === 0) {
        exists.payload = structuredClone(source.payload);
      }
    }
  }

  private cloneRecord<T extends Record<string, unknown>>(entry: T): T {
    return structuredClone(entry);
  }

  private scheduleNextRun(referenceDate: Date = new Date()): void {
    if (this.schedulerTimer) {
      clearTimeout(this.schedulerTimer);
      this.schedulerTimer = null;
    }

    const intervalSeconds = this.intervalSeconds;
    if (!(typeof intervalSeconds === "number" && Number.isFinite(intervalSeconds) && intervalSeconds > 0)) {
      return;
    }

    const intervalMs = intervalSeconds * 1000;
    const nowMs = referenceDate.getTime();
    const anchor = new Date(referenceDate);
    anchor.setMinutes(0, 0, 0);
    const anchorMs = anchor.getTime();
    const elapsedSinceAnchor = Math.max(0, nowMs - anchorMs);
    const slotsElapsed = Math.floor(elapsedSinceAnchor / intervalMs);
    let nextRunMs = anchorMs + (slotsElapsed + 1) * intervalMs;
    if (nextRunMs <= nowMs + 100) {
      nextRunMs += intervalMs;
    }
    const delayMs = Math.max(0, nextRunMs - nowMs);

    this.schedulerTimer = setTimeout(() => {
      this.schedulerTimer = null;
      this.triggerScheduledRun();
    }, delayMs);

    const approxMinutes = delayMs / 60000;
    this.logger.log(
      `Next simulation scheduled for ${new Date(nextRunMs).toISOString()} (~${approxMinutes.toFixed(2)} minutes)`,
    );
  }

  private triggerScheduledRun(): void {
    void this.seedFromConfig().catch(() => {
      // Errors are logged within seedFromConfig; scheduling resumes via finally block.
    });
  }

  private trimForecastByPriceCoverage(
    entries: RawForecastEntry[],
    eras: ForecastEra[],
  ): { forecastEntries: RawForecastEntry[]; eras: ForecastEra[] } {
    if (!entries.length || !eras.length) {
      return {forecastEntries: [], eras: []};
    }

    const trimmedEntries: RawForecastEntry[] = [];
    const trimmedEras: ForecastEra[] = [];

    const total = Math.min(entries.length, eras.length);
    for (let index = 0; index < total; index += 1) {
      const entry = (entries[index] as MutableRecord | undefined) ?? {};
      const sanitizedEntry = structuredClone(entry) as RawForecastEntry;
      const rawPrice = (sanitizedEntry as { price_ct_per_kwh?: unknown }).price_ct_per_kwh;
      const priceCt = this.toNumber(rawPrice);
      if (priceCt === null) {
        break;
      }
      trimmedEntries.push(sanitizedEntry);
      trimmedEras.push(eras[index]);
    }

    return {forecastEntries: trimmedEntries, eras: trimmedEras};
  }

  private convertPriceToCents(value: unknown, unit: unknown): number | null {
    const numeric = this.toNumber(value);
    if (numeric === null) {
      return null;
    }
    const unitStr = typeof unit === "string" ? unit.trim().toLowerCase() : "";
    const by = (factor: number) => {
      const result = numeric * factor;
      return Number.isFinite(result) ? result : null;
    };

    if (!unitStr) {
      if (Math.abs(numeric) > 10) {
        return numeric;
      }
      return by(100);
    }

    if (unitStr.includes("ct") && unitStr.includes("/wh")) {
      return by(1000);
    }

    if (unitStr.includes("ct") && unitStr.includes("kwh")) {
      return numeric;
    }

    if (unitStr.includes("eur") && unitStr.includes("/mwh")) {
      return by(0.1);
    }

    if (unitStr.includes("€/") && unitStr.includes("mwh")) {
      return by(0.1);
    }

    if (unitStr.includes("eur") && unitStr.includes("/wh")) {
      return by(100000);
    }

    if ((unitStr.includes("eur") || unitStr.includes("€/")) && unitStr.includes("kwh")) {
      return by(100);
    }

    if (unitStr.includes("ct")) {
      return numeric;
    }

    if (unitStr.includes("eur")) {
      return by(100);
    }

    return by(100);
  }

  private derivePriceSnapshot(
    forecast: RawForecastEntry[],
    simulationConfig: SimulationConfig,
  ): number | null {
    if (!forecast.length) {
      return null;
    }
    const slots = normalizePriceSlots(forecast);
    if (!slots.length) {
      return null;
    }
    const basePrice = slots[0]?.price;
    if (typeof basePrice !== "number" || Number.isNaN(basePrice)) {
      return null;
    }
    return this.applyGridFee(basePrice, simulationConfig);
  }

  private async fetchJson(url: string, timeoutMs: number, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {...(init ?? {}), signal: controller.signal});
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  private applyGridFee(price: number, simulationConfig: SimulationConfig): number {
    const feeCandidate = simulationConfig.price?.grid_fee_eur_per_kwh ?? 0;
    const fee = Number.isFinite(feeCandidate) ? feeCandidate : 0;
    return price + fee;
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const numeric = Number(trimmed);
      return Number.isFinite(numeric) ? numeric : null;
    }
    return null;
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
