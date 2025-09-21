import { Injectable, Logger } from "@nestjs/common";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";

import { SimulationService } from "../simulation/simulation.service.js";
import type { SimulationConfig } from "../simulation/types.js";
import { extractForecastFromState, normalizePriceSlots } from "../simulation/simulation.service.js";

const DEFAULT_CONFIG_FILE = "../config.local.yaml";
const DEFAULT_MARKET_DATA_URL = "https://api.awattar.de/v1/marketdata";
const REQUEST_TIMEOUT_MS = 5000;

interface ConfigSection {
  enabled?: boolean;
  [key: string]: unknown;
}

interface ConfigFile {
  battery?: Record<string, unknown>;
  price?: Record<string, unknown>;
  logic?: Record<string, unknown>;
  evcc?: ConfigSection;
  market_data?: ConfigSection;
  state?: Record<string, unknown>;
}

interface PreparedSimulation {
  simulationConfig: SimulationConfig;
  liveState: { battery_soc?: number | null };
  forecast: Record<string, unknown>[];
  warnings: string[];
  errors: string[];
  priceSnapshot: number | null;
}

@Injectable()
export class ConfigSyncService {
  private readonly logger = new Logger(ConfigSyncService.name);

  constructor(private readonly simulationService: SimulationService) {}

  async seedFromConfig(): Promise<void> {
    const configPath = this.resolveConfigPath();
    let rawConfig: ConfigFile | null = null;

    try {
      rawConfig = await this.loadConfigFile(configPath);
    } catch (error) {
      this.logger.error(`Failed to read config file at ${configPath}: ${this.describeError(error)}`);
    }

    if (!rawConfig) {
      this.logger.warn("Config file not found or unreadable; falling back to fixture data.");
      this.simulationService.ensureSeedFromFixture();
      return;
    }

    this.logger.log(`Loaded configuration from ${configPath}`);

    let prepared: PreparedSimulation | null = null;
    try {
      this.logger.log("Preparing simulation inputs from configured data sources...");
      prepared = await this.prepareSimulation(rawConfig);
    } catch (error) {
      this.logger.error(`Failed to prepare simulation from config: ${this.describeError(error)}`);
    }

    if (!prepared) {
      this.logger.error("Config-based preparation returned no result; using fixture snapshot.");
      this.simulationService.ensureSeedFromFixture();
      return;
    }

    if (!prepared.forecast.length) {
      this.logger.error("No forecast data could be obtained from configured sources; using fixture snapshot.");
      this.simulationService.ensureSeedFromFixture();
      return;
    }

    try {
      this.logger.log(
        `Running simulation with ${prepared.forecast.length} forecast slots; live SOC: ${
          prepared.liveState.battery_soc ?? "n/a"
        }`,
      );
      this.simulationService.runSimulation({
        config: prepared.simulationConfig,
        liveState: prepared.liveState,
        forecast: prepared.forecast,
        warnings: prepared.warnings,
        errors: prepared.errors,
        priceSnapshotEurPerKwh: prepared.priceSnapshot,
      });
      this.logger.log("Seeded snapshot using config.local.yaml data sources.");
    } catch (error) {
      this.logger.error(`Simulation run failed; reverting to fixture snapshot: ${this.describeError(error)}`);
      this.simulationService.ensureSeedFromFixture();
    }
  }

  private resolveConfigPath(): string {
    const override = process.env.BATTERYCTL_CONFIG;
    if (override && override.trim().length > 0) {
      return resolve(process.cwd(), override.trim());
    }
    return resolve(process.cwd(), DEFAULT_CONFIG_FILE);
  }

  private async loadConfigFile(path: string): Promise<ConfigFile | null> {
    try {
      await access(path, fsConstants.R_OK);
    } catch {
      return null;
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

    const evccResult = await this.collectFromEvcc(configFile.evcc, simulationConfig, warnings);
    this.logger.log(
      `EVCC data: slots=${evccResult.forecast.length}, live_soc=${
        evccResult.liveSoc ?? "n/a"
      }, snapshot=${evccResult.priceSnapshot ?? "n/a"}`,
    );
    if (evccResult.liveSoc !== null && evccResult.liveSoc !== undefined) {
      liveState.battery_soc = evccResult.liveSoc;
    }

    let forecast: Record<string, unknown>[] = [...evccResult.forecast];
    let priceSnapshot = evccResult.priceSnapshot;

    const marketResult = await this.collectFromMarket(configFile.market_data, simulationConfig, warnings);

    const preferMarket = this.resolveBoolean(configFile.market_data?.prefer_market, true);
    this.logger.log(
      `Market data: slots=${marketResult.forecast.length}, snapshot=${
        marketResult.priceSnapshot ?? "n/a"
      }, prefer_market=${preferMarket}`,
    );
    if (marketResult.forecast.length && (preferMarket || !forecast.length)) {
      forecast = [...marketResult.forecast];
      priceSnapshot = marketResult.priceSnapshot ?? priceSnapshot;
    } else if (!forecast.length && marketResult.forecast.length) {
      forecast = [...marketResult.forecast];
      priceSnapshot = marketResult.priceSnapshot ?? priceSnapshot;
    }

    if (!forecast.length) {
      const message = "Unable to retrieve a price forecast from EVCC or market data endpoints.";
      errors.push(message);
      this.logger.warn(message);
    }

    forecast = this.filterFutureEntries(forecast);
    priceSnapshot = priceSnapshot ?? this.derivePriceSnapshot(forecast, simulationConfig);
    this.logger.log(
      `Prepared simulation summary: slots=${forecast.length}, price_snapshot=${priceSnapshot ?? "n/a"}`,
    );

    return {
      simulationConfig,
      liveState,
      forecast,
      warnings,
      errors,
      priceSnapshot: priceSnapshot ?? null,
    };
  }

  private buildSimulationConfig(configFile: ConfigFile): SimulationConfig {
    const battery = configFile.battery ?? {};
    const price = configFile.price ?? {};
    const logic = configFile.logic ?? {};
    const stateCfg = configFile.state ?? {};

    const capacity = this.resolveNumber(battery.capacity_kwh, 0);
    const chargePower = this.resolveNumber(battery.max_charge_power_w, 0);
    const floorSoc = this.resolveNumber(battery.auto_mode_floor_soc, null);

    const gridFee = this.resolveNumber(price.grid_fee_eur_per_kwh, null);
    const networkTariff = this.resolveNumber(price.network_tariff_eur_per_kwh, null);

    const intervalSeconds = this.resolveNumber(logic.interval_seconds, 300);
    const minHoldMinutes = this.resolveNumber(logic.min_hold_minutes, 0);
    const houseLoad = this.resolveNumber(logic.house_load_w, 1200);

    const simulationConfig: SimulationConfig = {
      battery: {
        capacity_kwh: capacity ?? 0,
        max_charge_power_w: chargePower ?? 0,
        auto_mode_floor_soc: floorSoc ?? undefined,
      },
      price: {
        grid_fee_eur_per_kwh: gridFee ?? networkTariff ?? 0,
        network_tariff_eur_per_kwh: networkTariff ?? undefined,
      },
      logic: {
        interval_seconds: intervalSeconds ?? undefined,
        min_hold_minutes: minHoldMinutes ?? undefined,
        house_load_w: houseLoad ?? undefined,
      },
      state: typeof stateCfg.path === "string" ? { path: stateCfg.path } : undefined,
    };

    return simulationConfig;
  }

  private async collectFromEvcc(
    evccConfig: ConfigSection | undefined,
    simulationConfig: SimulationConfig,
    warnings: string[],
  ): Promise<{ forecast: Record<string, unknown>[]; liveSoc: number | null; priceSnapshot: number | null }> {
    const forecast: Record<string, unknown>[] = [];
    let liveSoc: number | null = null;
    let priceSnapshot: number | null = null;

    const enabled = this.resolveBoolean(evccConfig?.enabled, false);
    const baseUrl = this.resolveString(evccConfig?.base_url ?? evccConfig?.baseUrl ?? evccConfig?.url);

    if (!enabled) {
      warnings.push("EVCC integration disabled in config.");
      this.logger.warn("EVCC integration disabled in config.");
      return { forecast, liveSoc, priceSnapshot };
    }

    if (!baseUrl) {
      warnings.push("EVCC base_url missing in config.");
      this.logger.warn("EVCC base_url missing in config.");
      return { forecast, liveSoc, priceSnapshot };
    }

    const trimmedBaseUrl = baseUrl.replace(/\/$/, "");
    let statePayload: Record<string, unknown> | null = null;

    try {
      const stateUrl = `${trimmedBaseUrl}/api/state`;
      this.logger.log(`Fetching EVCC state from ${stateUrl}`);
      const response = await this.fetchJson(stateUrl, REQUEST_TIMEOUT_MS);
      if (response && typeof response === "object") {
        statePayload = response as Record<string, unknown>;
      } else {
        warnings.push("EVCC state endpoint returned unexpected payload.");
        this.logger.warn("EVCC state endpoint returned unexpected payload.");
      }
    } catch (error) {
      const message = `State fetch from EVCC failed: ${this.describeError(error)}`;
      warnings.push(message);
      this.logger.warn(message);
      return { forecast, liveSoc, priceSnapshot };
    }

    if (statePayload) {
      liveSoc = this.extractBatterySoc(statePayload);
      const rawForecast = extractForecastFromState(statePayload);
      forecast.push(...this.filterFutureEntries(rawForecast));
      const rawPrice = this.extractPriceFromState(statePayload);
      if (rawPrice !== null && rawPrice !== undefined) {
        priceSnapshot = this.applyGridFee(rawPrice, simulationConfig);
      }
    }

    if (!forecast.length) {
      warnings.push("No forecast data present in EVCC state response.");
      this.logger.warn("No forecast data present in EVCC state response.");
    }

    if (priceSnapshot === null) {
      try {
        const tariffUrl = `${trimmedBaseUrl}/api/tariff`;
        this.logger.log(`Fetching EVCC tariff data from ${tariffUrl}`);
        const tariffPayload = await this.fetchJson(tariffUrl, REQUEST_TIMEOUT_MS);
        const tariffEntries = this.normalizeForecastEntries(tariffPayload);
        const derived = this.derivePriceSnapshot(tariffEntries, simulationConfig);
        if (derived !== null) {
          priceSnapshot = derived;
        }
      } catch (error) {
        const message = `EVCC tariff fetch failed: ${this.describeError(error)}`;
        warnings.push(message);
        this.logger.warn(message);
      }
    }

    return { forecast, liveSoc, priceSnapshot };
  }

  private async collectFromMarket(
    marketConfig: ConfigSection | undefined,
    simulationConfig: SimulationConfig,
    warnings: string[],
  ): Promise<{ forecast: Record<string, unknown>[]; priceSnapshot: number | null }> {
    const enabled = this.resolveBoolean(marketConfig?.enabled, true);
    const forecast: Record<string, unknown>[] = [];
    let priceSnapshot: number | null = null;

    if (!enabled) {
      warnings.push("Market data fetch disabled in config.");
      this.logger.warn("Market data fetch disabled in config.");
      return { forecast, priceSnapshot };
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

    return { forecast, priceSnapshot };
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

  private filterFutureEntries(entries: Record<string, unknown>[]): Record<string, unknown>[] {
    const now = Date.now();
    return entries.filter((entry) => {
      const start = this.parseDate(entry.start ?? entry.from);
      const end = this.parseDate(entry.end ?? entry.to);

      if (end && end.getTime() <= now) {
        return false;
      }
      if (start && start.getTime() <= now) {
        return true;
      }
      return !start || start.getTime() >= now;
    });
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
