import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";

import { SimulationService } from "../simulation/simulation.service.js";
import type { ForecastEra, SimulationConfig } from "../simulation/types.js";
import { normalizePriceSlots } from "../simulation/simulation.service.js";

const DEFAULT_CONFIG_FILE = "../config.local.yaml";
const DEFAULT_MARKET_DATA_URL = "https://api.awattar.de/v1/marketdata";
const REQUEST_TIMEOUT_MS = 5000;
const SLOT_DURATION_MS = 3_600_000;

interface ConfigSection {
  enabled?: boolean;
  [key: string]: unknown;
}

interface ConfigFile {
  battery?: Record<string, unknown>;
  price?: Record<string, unknown>;
  logic?: Record<string, unknown>;
  // evcc removed
  evcc?: never;
  market_data?: ConfigSection;
  state?: Record<string, unknown>;
  solar?: Record<string, unknown>;
}

interface PreparedSimulation {
  simulationConfig: SimulationConfig;
  liveState: { battery_soc?: number | null };
  forecast: Record<string, unknown>[];
  warnings: string[];
  errors: string[];
  priceSnapshot: number | null;
  solarForecast: Record<string, unknown>[];
  forecastEras: ForecastEra[];
}

interface NormalizedSlot {
  payload: Record<string, unknown>;
  startDate: Date | null;
  endDate: Date | null;
  startIso: string | null;
  endIso: string | null;
  durationHours: number | null;
}

type ForecastCostPayload = Record<string, unknown> & {
  price?: unknown;
  value?: unknown;
  unit?: unknown;
  price_unit?: unknown;
  value_unit?: unknown;
  price_ct_per_kwh?: number | null;
};

@Injectable()
export class ConfigSyncService {
  private readonly logger = new Logger(ConfigSyncService.name);

  constructor(private readonly simulationService: SimulationService) {}

  async seedFromConfig(): Promise<void> {
    const configPath = this.resolveConfigPath();
    try {
      const rawConfig = await this.loadConfigFile(configPath);

      this.logger.log(`Loaded configuration from ${configPath}`);

      this.logger.log("Preparing simulation inputs from configured data sources...");
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
      this.simulationService.runSimulation({
        config: prepared.simulationConfig,
        liveState: prepared.liveState,
        forecast: prepared.forecast,
        solarForecast: prepared.solarForecast,
        forecastEras: prepared.forecastEras,
        warnings: prepared.warnings,
        errors: prepared.errors,
        priceSnapshotEurPerKwh: prepared.priceSnapshot,
      });
      this.logger.log("Seeded snapshot using config data.");
    } catch (error) {
      this.logger.error(`Config sync failed: ${this.describeError(error)}`);
      throw error;
    }
  }

  private resolveConfigPath(): string {
    const override = process.env.BATTERYCTL_CONFIG;
    if (override && override.trim().length > 0) {
      return resolve(process.cwd(), override.trim());
    }
    return resolve(process.cwd(), DEFAULT_CONFIG_FILE);
  }

  private async loadConfigFile(path: string): Promise<ConfigFile> {
    try {
      await access(path, fsConstants.R_OK);
    } catch (error) {
      throw new Error(`Config file not accessible at ${path}: ${this.describeError(error)}`);
    }

    const rawContent = await readFile(path, "utf-8");
    const parsed = YAML.parse(rawContent) as ConfigFile | null;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Config file is empty or invalid");
    }
    return parsed;
  }

  private async prepareSimulation(configFile: ConfigFile): Promise<PreparedSimulation> {
    const simulationConfig = this.buildSimulationConfig(configFile);
    const warnings: string[] = [];
    const errors: string[] = [];
    const liveState: { battery_soc?: number | null } = {};

    // EVCC removed; start with empty and rely on market data
    let forecast: Record<string, unknown>[] = [];
    let priceSnapshot: number | null = null;
    let solarForecast: Record<string, unknown>[] = [];

    const marketResult = await this.collectFromMarket(configFile.market_data, simulationConfig, warnings);
    const futureMarketForecast = this.filterFutureEntries(marketResult.forecast);

    const preferMarket = this.resolveBoolean(configFile.market_data?.prefer_market, true);
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

    if (!forecast.length) {
      const message = "Unable to retrieve a price forecast from market data endpoint.";
      errors.push(message);
      this.logger.warn(message);
    }

    const { forecastEntries, eras } = this.buildForecastEras(
      forecast,
      [],
      futureMarketForecast,
      solarForecast,
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
    };
  }

  private buildSimulationConfig(configFile: ConfigFile): SimulationConfig {
    const battery = configFile.battery ?? {};
    const price = configFile.price ?? {};
    const logic = configFile.logic ?? {};
    const solar = configFile.solar ?? {};
    const stateCfg = configFile.state ?? {};

    const capacity = this.resolveNumber(battery.capacity_kwh, 0);
    const chargePower = this.resolveNumber(battery.max_charge_power_w, 0);
    const floorSoc = this.resolveNumber(battery.auto_mode_floor_soc, null);

    const gridFee = this.resolveNumber(price.grid_fee_eur_per_kwh, null);
    const networkTariff = this.resolveNumber(price.network_tariff_eur_per_kwh, null);
    const feedInTariff = this.resolveNumber(price.feed_in_tariff_eur_per_kwh, null);

    const intervalSeconds = this.resolveNumber(logic.interval_seconds, 300);
    const minHoldMinutes = this.resolveNumber(logic.min_hold_minutes, 0);
    const houseLoad = this.resolveNumber(logic.house_load_w, 1200);
    const directUseRatio = this.resolveNumber(solar.direct_use_ratio, null);

    const simulationConfig: SimulationConfig = {
      battery: {
        capacity_kwh: capacity ?? 0,
        max_charge_power_w: chargePower ?? 0,
        auto_mode_floor_soc: floorSoc ?? undefined,
      },
      price: {
        grid_fee_eur_per_kwh: gridFee ?? networkTariff ?? 0,
        network_tariff_eur_per_kwh: networkTariff ?? undefined,
        feed_in_tariff_eur_per_kwh: feedInTariff ?? undefined,
      },
      logic: {
        interval_seconds: intervalSeconds ?? undefined,
        min_hold_minutes: minHoldMinutes ?? undefined,
        house_load_w: houseLoad ?? undefined,
      },
      solar:
        directUseRatio === null
          ? undefined
          : {
              direct_use_ratio: Math.min(Math.max(directUseRatio, 0), 1),
            },
      state: typeof stateCfg.path === "string" ? { path: stateCfg.path } : undefined,
    };

    return simulationConfig;
  }

  // EVCC collection removed

  private async collectFromMarket(
    marketConfig: ConfigSection | undefined,
    simulationConfig: SimulationConfig,
    warnings: string[],
  ): Promise<{ forecast: Record<string, unknown>[]; priceSnapshot: number | null; solar: Record<string, unknown>[] }> {
    const enabled = this.resolveBoolean(marketConfig?.enabled, true);
    const forecast: Record<string, unknown>[] = [];
    let priceSnapshot: number | null = null;

    if (!enabled) {
      warnings.push("Market data fetch disabled in config.");
      this.logger.warn("Market data fetch disabled in config.");
      return { forecast, priceSnapshot, solar: [] };
    }

    const endpoint = this.resolveString(marketConfig?.url) ?? DEFAULT_MARKET_DATA_URL;
    const maxHours = this.resolveNumber(marketConfig?.max_hours, 72) ?? 72;

    try {
      this.logger.log(`Fetching market forecast from ${endpoint} (max ${maxHours}h)`);
      const payload = await this.fetchJson(endpoint, REQUEST_TIMEOUT_MS);
      forecast.push(...this.normalizeForecastEntries(payload, maxHours));
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

    return { forecast, priceSnapshot, solar: [] };
  }

  private normalizeForecastEntries(payload: unknown, maxHours = 72): Record<string, unknown>[] {
    const records: Record<string, unknown>[] = [];
    if (!payload) {
      return records;
    }

    let data: unknown[] = [];
    if (Array.isArray(payload)) {
      data = payload;
    } else if (typeof payload === "object" && payload !== null) {
      const container = payload as Record<string, unknown>;
      const nested = container.data ?? container.items ?? container.forecast ?? [];
      if (Array.isArray(nested)) {
        data = nested;
      }
    }

    const now = Date.now();
    const horizonEnd = now + maxHours * 3600_000;

    for (const entry of data) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const startValue = record.start_timestamp ?? record.startTimestamp ?? record.start ?? record.from;
      const endValue = record.end_timestamp ?? record.endTimestamp ?? record.end ?? record.to;
      const priceValue = record.marketprice ?? record.price ?? record.value;

      const startDate = this.parseDate(startValue);
      if (!startDate) {
        continue;
      }

      let endDate = this.parseDate(endValue);
      if (!endDate) {
        const durationHours = this.resolveNumber(record.duration_hours ?? record.durationHours, 1) ?? 1;
        endDate = new Date(startDate.getTime() + durationHours * 3600_000);
      }

      if (endDate.getTime() <= now) {
        continue;
      }
      if (startDate.getTime() >= horizonEnd) {
        continue;
      }

      const price = this.resolveNumber(priceValue, null);
      if (price === null) {
        continue;
      }

      records.push({
        start: startDate.toISOString(),
        end: endDate.toISOString(),
        price,
        unit: record.unit ?? record.price_unit ?? record.value_unit,
      });
    }

    return records;
  }

  private extractSolarForecast(state: Record<string, unknown>): Record<string, unknown>[] {
    const forecastRecord = this.extractRecord((state as { forecast?: unknown }).forecast);
    const solarRecord = this.extractRecord(forecastRecord?.solar);
    const timeseries = Array.isArray(solarRecord?.timeseries)
      ? (solarRecord?.timeseries as unknown[])
      : [];

    const entries: Record<string, unknown>[] = [];
    for (let index = 0; index < timeseries.length; index += 1) {
      const item = timeseries[index];
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as { ts?: unknown; val?: unknown; value?: unknown; energy_kwh?: unknown; energy_wh?: unknown };
      const start = this.parseDate(record.ts);
      if (!start) {
        continue;
      }

      const next = index + 1 < timeseries.length ? timeseries[index + 1] : undefined;
      const end =
        this.parseDate((next as { ts?: unknown } | undefined)?.ts) ??
        new Date(start.getTime() + SLOT_DURATION_MS);

      const durationMs = end.getTime() - start.getTime();
      if (!(durationMs > 0)) {
        continue;
      }

      let energyKwh = this.resolveNumber(record.energy_kwh, null);
      if (energyKwh === null) {
        const energyWh = this.resolveNumber(record.energy_wh, null);
        if (energyWh !== null) {
          energyKwh = energyWh / 1000;
        }
      }

      if (energyKwh === null) {
        const rawPower = this.resolveNumber(record.value ?? record.val, null);
        if (rawPower !== null) {
          let powerKw = rawPower;
          if (powerKw > 1000) {
            powerKw /= 1000;
          }
          const durationHours = durationMs / SLOT_DURATION_MS;
          energyKwh = powerKw * durationHours;
        }
      }

      if (energyKwh === null || !Number.isFinite(energyKwh) || energyKwh <= 0) {
        continue;
      }

      entries.push({
        start: start.toISOString(),
        end: end.toISOString(),
        energy_kwh: energyKwh,
      });
    }

    return entries;
  }

  private filterFutureEntries(entries: Record<string, unknown>[]): Record<string, unknown>[] {
    const now = Date.now();
    return entries.filter((entry) => {
      const start = this.parseDate(entry.start ?? entry.from);
      const end = this.parseDate(entry.end ?? entry.to);

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
    canonicalForecast: Record<string, unknown>[],
    evccForecast: Record<string, unknown>[],
    marketForecast: Record<string, unknown>[],
    solarForecast: Record<string, unknown>[],
  ): { forecastEntries: Record<string, unknown>[]; eras: ForecastEra[] } {
    if (!canonicalForecast.length) {
      return { forecastEntries: [], eras: [] };
    }

    const canonicalSlots = canonicalForecast
      .map((entry) => this.normalizeForecastSlot(entry))
      .filter((slot) => slot.startIso !== null)
      .sort((a, b) => {
        const aTime = a.startDate?.getTime() ?? 0;
        const bTime = b.startDate?.getTime() ?? 0;
        return aTime - bTime;
      });

    const marketIndex = this.buildStartIndex(marketForecast);

    const solarSlots = solarForecast
      .map((entry) => this.normalizeForecastSlot(entry))
      .filter((slot) => slot.startDate !== null)
      .sort((a, b) => {
        const aTime = a.startDate?.getTime() ?? 0;
        const bTime = b.startDate?.getTime() ?? 0;
        return aTime - bTime;
      });

    const findSolarPayload = (
      startDate: Date | null,
      endDate: Date | null,
    ): Record<string, unknown> | undefined => {
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

    const forecastEntries: Record<string, unknown>[] = [];
    const eras: ForecastEra[] = [];

    for (const slot of canonicalSlots) {
      if (!slot.startIso) {
        continue;
      }
      const eraId = randomUUID();
      const payload = { ...slot.payload, era_id: eraId };
      forecastEntries.push(payload);

      const sources: ForecastEra["sources"] = [];

      const marketPayload = marketIndex.get(slot.startIso);
      if (marketPayload) {
        const cloned = this.cloneRecord(marketPayload);
        const record: ForecastCostPayload = { ...cloned };
        const rawPrice = record.price ?? record.value;
        const rawUnit = record.unit ?? record.price_unit ?? record.value_unit;
        const priceCt = this.convertPriceToCents(rawPrice, rawUnit);
        if (priceCt !== null) {
          record.price_ct_per_kwh = priceCt;
          record.unit = "ct/kWh";
        }
        sources.push({ provider: "awattar", type: "cost", payload: record });
      }

      const solarPayload = findSolarPayload(slot.startDate, slot.endDate);
      if (solarPayload) {
        sources.push({ provider: "solar", type: "solar", payload: solarPayload });
      }

      eras.push({
        era_id: eraId,
        start: slot.startIso,
        end: slot.endIso,
        duration_hours: slot.durationHours,
        sources,
      });
    }

    return { forecastEntries, eras };
  }

  private buildStartIndex(entries: Record<string, unknown>[]): Map<string, Record<string, unknown>> {
    const index = new Map<string, Record<string, unknown>>();
    for (const entry of entries) {
      const slot = this.normalizeForecastSlot(entry);
      if (!slot.startIso) {
        continue;
      }
      index.set(slot.startIso, slot.payload);
    }
    return index;
  }

  private normalizeForecastSlot(entry: Record<string, unknown>): NormalizedSlot {
    const payload = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
    const startDate = this.parseDate(payload.start ?? payload.from);
    const endDateCandidate = this.parseDate(payload.end ?? payload.to);
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

  private cloneRecord(entry: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
  }

  private convertPriceToCents(value: unknown, unit: unknown): number | null {
    const numeric = this.resolveNumber(value, null);
    if (numeric === null) {
      return null;
    }
    const unitStr = typeof unit === "string" ? unit.trim().toLowerCase() : "";
    const by = (factor: number) => {
      const result = numeric * factor;
      return Number.isFinite(result) ? result : null;
    };

    if (!unitStr) {
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
    forecast: Record<string, unknown>[],
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

  private async fetchJson(url: string, timeoutMs: number): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  private extractBatterySoc(payload: Record<string, unknown>): number | null {
    const site = this.extractRecord(payload.site);
    const candidates = [site?.batterySoc, payload.batterySoc, payload.battery_soc];
    for (const value of candidates) {
      const numeric = this.resolveNumber(value, null);
      if (numeric !== null) {
        return numeric;
      }
    }
    return null;
  }

  private extractPriceFromState(payload: Record<string, unknown>): number | null {
    const site = this.extractRecord(payload.site);
    const keys = ["tariffGrid", "tariffPriceLoadpoints", "tariffPriceHome", "gridPrice"];
    for (const key of keys) {
      const fromSite = this.resolveNumber(site?.[key], null);
      if (fromSite !== null) {
        return fromSite;
      }
      const direct = this.resolveNumber(payload[key], null);
      if (direct !== null) {
        return direct;
      }
    }

    const forecast = payload.forecast;
    if (forecast && typeof forecast === "object") {
      const sequences = Object.values(forecast as Record<string, unknown>);
      for (const seq of sequences) {
        if (!Array.isArray(seq) || !seq.length) {
          continue;
        }
        const arraySeq: unknown[] = seq;
        const first = arraySeq[0];
        if (!first || typeof first !== "object") {
          continue;
        }
        const record = first as Record<string, unknown>;
        const value = this.resolveNumber(record.value ?? record.price, null);
        if (value !== null) {
          return value;
        }
      }
    }

    return null;
  }

  private applyGridFee(price: number, simulationConfig: SimulationConfig): number {
    const fee = this.resolveNumber(
      simulationConfig.price?.grid_fee_eur_per_kwh ?? simulationConfig.price?.network_tariff_eur_per_kwh,
      0,
    ) ?? 0;
    return price + fee;
  }

  private parseDate(value: unknown): Date | null {
    if (value instanceof Date) {
      return new Date(value.getTime());
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      const timestamp = value > 1e12 ? value : value * 1000;
      return new Date(timestamp);
    }
    if (typeof value === "string" && value.length > 0) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) {
        return parsed;
      }
    }
    return null;
  }

  private resolveNumber(value: unknown, fallback: number | null): number | null {
    if (value === null || value === undefined) {
      return fallback;
    }
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : fallback;
    }
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : fallback;
  }

  private resolveBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (["1", "true", "t", "yes", "y", "on"].includes(normalized)) {
        return true;
      }
      if (["0", "false", "f", "no", "n", "off"].includes(normalized)) {
        return false;
      }
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    return fallback;
  }

  private resolveString(value: unknown): string | null {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
    return null;
  }

  private extractRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
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
