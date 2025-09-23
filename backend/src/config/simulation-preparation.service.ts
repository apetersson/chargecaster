import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import { normalizePriceSlots } from "../simulation/simulation.service";
import type { ForecastEra, RawForecastEntry, RawSolarEntry, SimulationConfig } from "../simulation/types";
import { buildSolarForecastFromTimeseries, parseTimestamp } from "../simulation/solar";
import type { ConfigDocument } from "./schemas";
import { parseEvccState, parseMarketForecast } from "./schemas";
import { EnergyPrice, TimeSlot } from "@batteryctl/domain";

const DEFAULT_MARKET_DATA_URL = "https://api.awattar.de/v1/marketdata";
const REQUEST_TIMEOUT_MS = 15000;
const SLOT_DURATION_MS = 3_600_000;

type MutableRecord = Record<string, unknown>;

type EvccConfig = ConfigDocument["evcc"];
type MarketConfig = ConfigDocument["market_data"];
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
  intervalSeconds: number | null;
}

interface NormalizedSlot {
  payload: MutableRecord;
  startDate: Date | null;
  endDate: Date | null;
  startIso: string | null;
  endIso: string | null;
  durationHours: number | null;
  timeSlot: TimeSlot | null;
}

@Injectable()
export class SimulationPreparationService {
  private readonly logger = new Logger(SimulationPreparationService.name);

  async prepare(configFile: ConfigDocument): Promise<PreparedSimulation> {
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
      : forecast;

    const forecastErasResult = this.buildForecastEras(
      canonicalForecast,
      futureEvccForecast,
      futureMarketForecast,
      futureSolarForecast,
      simulationConfig.price.grid_fee_eur_per_kwh ?? 0,
    );

    const priceSnapshotValue = priceSnapshot ?? this.derivePriceSnapshot(forecast, simulationConfig);

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
      intervalSeconds: this.extractIntervalSeconds(simulationConfig),
    };
  }

  private extractIntervalSeconds(config: SimulationConfig): number | null {
    const value = config.logic?.interval_seconds;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    return null;
  }

  private buildSimulationConfig(configFile: ConfigDocument): SimulationConfig {
    const battery = configFile.battery ?? {};
    const price = configFile.price ?? {};
    const logic = configFile.logic ?? {};
    const solar = configFile.solar ?? {};

    const capacity = battery.capacity_kwh ?? 0;
    const chargePower = battery.max_charge_power_w ?? 0;
    const floorSoc = battery.auto_mode_floor_soc;
    const gridFee = price.grid_fee_eur_per_kwh ?? 0;
    const feedInTariff = price.feed_in_tariff_eur_per_kwh ?? null;

    const intervalSecondsRaw = logic.interval_seconds ?? 300;
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

    const normalizedIntervalSeconds =
      Number.isFinite(intervalSecondsRaw) && intervalSecondsRaw > 0
        ? intervalSecondsRaw
        : null;
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

  private filterFutureEntries(entries: RawForecastEntry[]): RawForecastEntry[] {
    const now = Date.now();
    return entries.filter((entry) => {
      const start = parseTimestamp(entry.start ?? entry.from ?? null);
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
        return structuredClone(direct.payload) as MutableRecord;
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
          return structuredClone(slot.payload) as MutableRecord;
        }
      }
      return undefined;
    };

    type CostSource = Extract<ForecastEra["sources"][number], { type: "cost" }>;
    type SolarSource = Extract<ForecastEra["sources"][number], { type: "solar" }>;

    interface EraEntry {
      slot: NormalizedSlot;
      payload: MutableRecord & { era_id: string };
      sources: ForecastEra["sources"];
    }

    const eraMap = new Map<string, EraEntry>();

    const addSource = (entry: EraEntry, source: ForecastEra["sources"][number]): void => {
      const exists = entry.sources.some((item) => item.provider === source.provider && item.type === source.type);
      if (!exists) {
        if (source.type === "cost") {
          const cloned: CostSource = {
            provider: source.provider,
            type: "cost",
            payload: structuredClone(source.payload),
          };
          entry.sources.push(cloned);
        } else {
          const cloned: SolarSource = {
            provider: source.provider,
            type: "solar",
            payload: structuredClone(source.payload),
          };
          entry.sources.push(cloned);
        }
      }
    };

    const buildSolarSource = (
      provider: string,
      slotInfo: NormalizedSlot,
      raw: MutableRecord | undefined,
    ): SolarSource | null => {
      if (!raw) {
        return null;
      }
      let energyWh = this.toNumber(raw.energy_wh);
      if (energyWh === null) {
        const energyKwh = this.toNumber(raw.energy_kwh);
        if (energyKwh !== null) {
          energyWh = energyKwh * 1000;
        }
      }
      if (energyWh === null || energyWh <= 0) {
        return null;
      }
      const durationHours = slotInfo.timeSlot?.duration.hours ?? slotInfo.durationHours ?? null;
      const averagePower = durationHours && durationHours > 0 ? energyWh / durationHours : undefined;
      return {
        provider,
        type: "solar",
        payload: averagePower !== undefined ? {energy_wh: energyWh, average_power_w: averagePower} : {energy_wh: energyWh},
      };
    };

    const applySlotPrice = (
      entry: EraEntry,
      rawPrice: unknown,
      rawUnit: unknown,
    ): CostSource["payload"] | null => {
      const energyPrice = this.parseEnergyPrice(rawPrice, rawUnit);
      if (!energyPrice) {
        return null;
      }
      const totalPrice = energyPrice.withAdditionalFee(gridFeeEurPerKwh);
      const payload = {
        price_ct_per_kwh: energyPrice.ctPerKwh,
        price_eur_per_kwh: energyPrice.eurPerKwh,
        price_with_fee_ct_per_kwh: totalPrice.ctPerKwh,
        price_with_fee_eur_per_kwh: totalPrice.eurPerKwh,
        unit: "ct/kWh",
      } satisfies CostSource["payload"];

      entry.slot.payload.price = payload.price_eur_per_kwh;
      entry.slot.payload.unit = "EUR/kWh";
      entry.slot.payload.price_ct_per_kwh = payload.price_ct_per_kwh;
      entry.slot.payload.price_eur_per_kwh = payload.price_eur_per_kwh;
      entry.slot.payload.price_with_fee_ct_per_kwh = payload.price_with_fee_ct_per_kwh;
      entry.slot.payload.price_with_fee_eur_per_kwh = payload.price_with_fee_eur_per_kwh;

      entry.payload.price = payload.price_eur_per_kwh;
      entry.payload.unit = "EUR/kWh";
      entry.payload.price_ct_per_kwh = payload.price_ct_per_kwh;
      entry.payload.price_with_fee_ct_per_kwh = payload.price_with_fee_ct_per_kwh;
      entry.payload.price_with_fee_eur_per_kwh = payload.price_with_fee_eur_per_kwh;

      return payload;
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
      const baseCost = applySlotPrice(entry, rawPrice, rawUnit);
      if (baseCost) {
        const costSource: CostSource = {
          provider: "canonical",
          type: "cost",
          payload: baseCost,
        };
        addSource(entry, costSource);
      }

      const marketPayload = marketIndex.get(slot.startIso);
      if (marketPayload) {
        const rawMarketPrice = (marketPayload as { price?: unknown; value?: unknown }).price ??
          (marketPayload as { value?: unknown }).value;
        const rawMarketUnit = (marketPayload as { unit?: unknown }).unit ??
          (marketPayload as { price_unit?: unknown }).price_unit ??
          (marketPayload as { value_unit?: unknown }).value_unit;
        const marketCost = applySlotPrice(entry, rawMarketPrice, rawMarketUnit);
        if (marketCost) {
          const marketSource: CostSource = {
            provider: "awattar",
            type: "cost",
            payload: marketCost,
          };
          addSource(entry, marketSource);
        }
      }

      const solarPayload = findSolarPayload(slot.startDate, slot.endDate);
      const solarSource = buildSolarSource("evcc", entry.slot, solarPayload);
      if (solarSource) {
        addSource(entry, solarSource);
      }
    }

    const sorted = [...eraMap.entries()].sort((a, b) => {
      const aStart = parseTimestamp(a[0])?.getTime() ?? 0;
      const bStart = parseTimestamp(b[0])?.getTime() ?? 0;
      return aStart - bStart;
    });

    const dedupedEntries: RawForecastEntry[] = [];
    const dedupedEras: ForecastEra[] = [];
    for (const [, value] of sorted) {
      dedupedEntries.push(structuredClone(value.slot.payload) as RawForecastEntry);
      dedupedEras.push(structuredClone({
        era_id: value.payload.era_id,
        start: value.slot.startIso ?? undefined,
        end: value.slot.endIso ?? undefined,
        duration_hours: value.slot.durationHours,
        sources: value.sources,
      }) as ForecastEra);
    }

    return {forecastEntries: dedupedEntries, eras: dedupedEras};
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

  private normalizeMarketEntries(entries: RawForecastEntry[], maxHours = 72): RawForecastEntry[] {
    const records: RawForecastEntry[] = [];
    if (!entries.length) {
      return records;
    }

    const now = Date.now();
    for (const entry of entries) {
      if (!entry) continue;
      const startTimestamp = parseTimestamp(entry.start ?? entry.from ?? null);
      const endTimestamp = parseTimestamp(entry.end ?? entry.to ?? null);
      if (!startTimestamp || !endTimestamp) {
        continue;
      }
      if (startTimestamp.getTime() < now - SLOT_DURATION_MS) {
        continue;
      }
      const durationHours = (endTimestamp.getTime() - startTimestamp.getTime()) / 3_600_000;
      if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > maxHours) {
        continue;
      }
      records.push(entry);
    }
    return records;
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

  private normalizeForecastSlot(entry: RawForecastEntry): NormalizedSlot {
    const payload = structuredClone(entry) as MutableRecord;
    const startDate = parseTimestamp(payload.start ?? payload.from);
    let endDate = parseTimestamp(payload.end ?? payload.to);
    if (!endDate && startDate) {
      endDate = new Date(startDate.getTime() + SLOT_DURATION_MS);
    }
    if (startDate && endDate && endDate.getTime() <= startDate.getTime()) {
      endDate = new Date(startDate.getTime() + SLOT_DURATION_MS);
    }
    const startIso = startDate ? startDate.toISOString() : null;
    const endIso = endDate ? endDate.toISOString() : null;
    if (startIso) {
      payload.start = startIso;
    }
    if (endIso) {
      payload.end = endIso;
    }
    let timeSlot: TimeSlot | null = null;
    if (startDate && endDate) {
      try {
        timeSlot = TimeSlot.fromDates(startDate, endDate);
      } catch (error) {
        void error;
        timeSlot = null;
      }
    }
    const durationHours = timeSlot ? timeSlot.duration.hours : null;

    return {
      payload,
      startDate,
      endDate,
      startIso,
      endIso,
      durationHours,
      timeSlot,
    };
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
    return basePrice + (simulationConfig.price?.grid_fee_eur_per_kwh ?? 0);
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    }
    return null;
  }

  private parseEnergyPrice(value: unknown, unit: unknown): EnergyPrice | null {
    const numeric = this.toNumber(value);
    if (numeric === null) {
      return null;
    }
    const unitStrRaw = typeof unit === "string" ? unit.trim() : "";
    const unitStr = unitStrRaw.toLowerCase();
    if (unitStr.length) {
      const parsed = EnergyPrice.tryFromValue(numeric, unitStr);
      if (parsed) {
        return parsed;
      }
    }
    if (Math.abs(numeric) > 10) {
      return EnergyPrice.fromCentsPerKwh(numeric);
    }
    return EnergyPrice.fromEurPerKwh(numeric);
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

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
