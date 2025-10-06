import { Inject, Injectable, Logger } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ForecastEra,
  ForecastResponse,
  HistoryPoint,
  HistoryResponse,
  OracleEntry,
  OracleResponse,
  PriceSlot,
  RawForecastEntry,
  RawSolarEntry,
  SimulationConfig,
  SnapshotPayload,
  SnapshotSummary,
} from "./types";
import { normalizeHistoryList } from "./history.serializer";
import { StorageService } from "../storage/storage.service";
import { BacktestSavingsService } from "./backtest.service";
import { buildSolarForecastFromTimeseries, parseTimestamp } from "./solar";
import { parseEvccState } from "../config/schemas";
import { EnergyPrice, TariffSlot } from "@chargecaster/domain";

const SOC_STEPS = 100;
const SLOT_DURATION_MS = 3_600_000;

export interface SimulationInput {
  config: SimulationConfig;
  liveState: { battery_soc?: number | null };
  forecast: RawForecastEntry[];
  warnings?: string[];
  errors?: string[];
  priceSnapshotEurPerKwh?: number | null;
  solarForecast?: RawSolarEntry[];
  forecastEras?: ForecastEra[];
  observations?: {
    gridPowerW?: number | null;
    solarPowerW?: number | null;
  };
}

@Injectable()
export class SimulationService {
  private readonly logger = new Logger(SimulationService.name);

  constructor(
    @Inject(StorageService) private readonly storageRef: StorageService,
    @Inject(BacktestSavingsService) private readonly backtestService: BacktestSavingsService,
  ) {
  }

  getLatestSnapshot(): SnapshotPayload | null {
    const record = this.storageRef.getLatestSnapshot();
    if (!record) {
      return null;
    }
    const payload = record.payload;
    const historyRecords = this.storageRef.listHistory();
    const history = normalizeHistoryList(historyRecords.map((item) => item.payload));
    return {
      ...payload,
      history,
    };
  }

  ensureSeedFromFixture(): SnapshotPayload {
    const existing = this.getLatestSnapshot();
    if (existing) {
      const hasForecast = Array.isArray(existing.forecast_eras) && existing.forecast_eras.length > 0;
      if (hasForecast) {
        return existing;
      }
    }

    const fixturePath = join(process.cwd(), "fixtures", "sample_data.json");
    const raw = JSON.parse(readFileSync(fixturePath, "utf-8")) as unknown;
    let parsedState: ReturnType<typeof parseEvccState> | null = null;
    try {
      parsedState = parseEvccState(raw);
    } catch (error) {
      this.logger.warn(`Failed to parse fixture state: ${String(error)}`);
    }

    const tariffGrid = parsedState?.priceSnapshot ?? 0.02;

    const config: SimulationConfig = {
      battery: {
        capacity_kwh: 12,
        max_charge_power_w: 500,
        auto_mode_floor_soc: 5,
      },
      price: {
        grid_fee_eur_per_kwh: tariffGrid,
        feed_in_tariff_eur_per_kwh: 0.03,
      },
      logic: {
        interval_seconds: 300,
        min_hold_minutes: 20,
        house_load_w: 1200,
        allow_battery_export: true,
      },
      solar: {
        direct_use_ratio: 0.6,
      },
    };

    const forecast = parsedState?.forecast ?? [];
    const solarForecast = buildSolarForecastFromTimeseries(parsedState?.solarTimeseries ?? []);
    const liveState = {
      battery_soc: parsedState?.batterySoc ?? 40,
    };
    return this.runSimulation({config, liveState, forecast, solarForecast});
  }

  getSummary(): SnapshotSummary {
    const snapshot = this.ensureSeedFromFixture();
    return {
      timestamp: snapshot.timestamp,
      interval_seconds: snapshot.interval_seconds,
      house_load_w: snapshot.house_load_w,
      current_soc_percent: snapshot.current_soc_percent,
      next_step_soc_percent: snapshot.next_step_soc_percent,
      recommended_soc_percent: snapshot.recommended_soc_percent,
      recommended_final_soc_percent: snapshot.recommended_final_soc_percent,
      current_mode: snapshot.current_mode,
      price_snapshot_eur_per_kwh: snapshot.price_snapshot_eur_per_kwh,
      projected_cost_eur: snapshot.projected_cost_eur,
      baseline_cost_eur: snapshot.baseline_cost_eur,
      basic_battery_cost_eur: snapshot.basic_battery_cost_eur,
      backtested_savings_eur: snapshot.backtested_savings_eur,
      projected_savings_eur: snapshot.projected_savings_eur,
      projected_grid_power_w: snapshot.projected_grid_power_w,
      forecast_hours: snapshot.forecast_hours,
      forecast_samples: snapshot.forecast_samples,
      warnings: snapshot.warnings ?? [],
      errors: snapshot.errors ?? [],
    };
  }

  getHistory(limit = 96): HistoryResponse {
    const snapshot = this.ensureSeedFromFixture();
    const historyRecords = this.storageRef.listHistory(limit);
    const entries = normalizeHistoryList(historyRecords.map((item) => item.payload));
    return {
      generated_at: snapshot.timestamp,
      entries,
    };
  }

  getForecast(): ForecastResponse {
    const snapshot = this.ensureSeedFromFixture();
    const eras = Array.isArray(snapshot.forecast_eras) ? snapshot.forecast_eras : [];
    return {
      generated_at: snapshot.timestamp,
      eras,
    };
  }

  getOracle(): OracleResponse {
    const snapshot = this.ensureSeedFromFixture();
    const entries = Array.isArray(snapshot.oracle_entries)
      ? snapshot.oracle_entries.filter((entry): entry is OracleEntry => typeof entry?.era_id === "string")
      : [];
    return {
      generated_at: snapshot.timestamp,
      entries,
    };
  }

  runSimulation(input: SimulationInput): SnapshotPayload {
    if (!this.storageRef) {
      throw new Error("Storage service not initialised");
    }
    const resolvedSoc = this.resolveLiveSoc(input.liveState?.battery_soc);
    const liveState = {battery_soc: resolvedSoc};
    const slots = normalizePriceSlots(input.forecast);
    const solarSlots = normalizeSolarSlots(input.solarForecast ?? []);
    const solarMap = new Map<number, number>();
    for (const slot of solarSlots) {
      const key = Math.floor(slot.start.getTime() / SLOT_DURATION_MS);
      const energy = Math.max(0, slot.energy_kwh);
      solarMap.set(key, (solarMap.get(key) ?? 0) + energy);
    }

    const solarGeneration = slots.map((slot) => {
      const key = Math.floor(slot.start.getTime() / SLOT_DURATION_MS);
      return solarMap.get(key) ?? 0;
    });

    const directUseRatio = clampRatio(input.config.solar?.direct_use_ratio ?? 0);
    const feedInTariff = Math.max(0, Number(input.config.price?.feed_in_tariff_eur_per_kwh ?? 0));

    const result = simulateOptimalSchedule(input.config, liveState, slots, {
      solarGenerationKwhPerSlot: solarGeneration,
      pvDirectUseRatio: directUseRatio,
      feedInTariffEurPerKwh: feedInTariff,
      allowBatteryExport: input.config.logic?.allow_battery_export ?? true,
    });
    const initialSoc = result.initial_soc_percent;
    const nextSoc = result.next_step_soc_percent ?? initialSoc;
    const firstStrategy = result.oracle_entries[0]?.strategy ?? null;
    let currentMode: "charge" | "auto";
    if (firstStrategy) {
      currentMode = firstStrategy;
    } else if (nextSoc > initialSoc + 0.5) {
      currentMode = "charge";
    } else {
      currentMode = "auto";
    }
    this.logger.log(`Simulation result: ${currentMode.toUpperCase()}`);
    if (result.oracle_entries.length) {
      const strategyLog = result.oracle_entries
        .map((entry) => `${(entry.strategy ?? "auto").toUpperCase()}@${entry.era_id}`)
        .join("\n");
      this.logger.log(`Era strategies: \n${strategyLog}`);
    }
    const fallbackPriceEur = slots.length
      ? slots[0].price + gridFee(input.config)
      : null;
    const priceSnapshotEur =
      input.priceSnapshotEurPerKwh ?? (fallbackPriceEur ?? null);
    const priceSnapshotCt = priceSnapshotEur !== null ? priceSnapshotEur * 100 : null;
    const warnings = Array.isArray(input.warnings) ? [...input.warnings] : [];
    const errors = Array.isArray(input.errors) ? [...input.errors] : [];
    const fallbackEras = buildErasFromSlots(slots);
    const hasProvidedEras = (input.forecastEras?.length ?? 0) > 0;
    const autoResult = simulateOptimalSchedule(input.config, liveState, slots, {
      solarGenerationKwhPerSlot: solarGeneration,
      pvDirectUseRatio: directUseRatio,
      feedInTariffEurPerKwh: feedInTariff,
      allowBatteryExport: input.config.logic?.allow_battery_export ?? true,
      allowGridChargeFromGrid: false,
    });
    const snapshot: SnapshotPayload = {
      timestamp: result.timestamp,
      interval_seconds: input.config.logic?.interval_seconds ?? null,
      house_load_w: input.config.logic?.house_load_w ?? null,
      current_soc_percent: result.initial_soc_percent,
      next_step_soc_percent: result.next_step_soc_percent,
      recommended_soc_percent: result.recommended_soc_percent,
      recommended_final_soc_percent: result.recommended_final_soc_percent,
      current_mode: currentMode,
      price_snapshot_ct_per_kwh: priceSnapshotCt,
      price_snapshot_eur_per_kwh: priceSnapshotEur,
      projected_cost_eur: result.projected_cost_eur,
      baseline_cost_eur: result.baseline_cost_eur,
      basic_battery_cost_eur: autoResult.projected_cost_eur,
      projected_savings_eur: result.projected_savings_eur,
      active_control_savings_eur: autoResult.projected_cost_eur !== null && result.projected_cost_eur !== null
        ? autoResult.projected_cost_eur - result.projected_cost_eur
        : null,
      backtested_savings_eur: null,
      projected_grid_power_w: result.projected_grid_power_w,
      forecast_hours: result.forecast_hours,
      forecast_samples: result.forecast_samples,
      forecast_eras: hasProvidedEras ? input.forecastEras! : fallbackEras,
      oracle_entries: result.oracle_entries,
      history: [],
      warnings,
      errors,
    };
    const historyEntry: HistoryPoint = {
      timestamp: result.timestamp,
      battery_soc_percent: result.initial_soc_percent,
      price_eur_per_kwh: priceSnapshotEur,
      price_ct_per_kwh: priceSnapshotCt,
      grid_power_w: null,
      solar_power_w: null,
      solar_energy_wh: null,
      backtested_savings_eur: null,
    };

    const observedGridPower = input.observations?.gridPowerW;
    if (typeof observedGridPower === "number" && Number.isFinite(observedGridPower)) {
      historyEntry.grid_power_w = observedGridPower;
    }

    const firstSolarKwh = solarGeneration[0];
    const firstSlot = slots[0];
    const observedSolarPower = input.observations?.solarPowerW;
    if (typeof firstSolarKwh === "number" && Number.isFinite(firstSolarKwh) && firstSlot) {
      const durationHours = firstSlot.durationHours ?? 0;
      if (firstSolarKwh > 0) {
        historyEntry.solar_energy_wh = firstSolarKwh * 1000;
        if (durationHours > 0) {
          historyEntry.solar_power_w = (firstSolarKwh / durationHours) * 1000;
        }
      } else if (firstSolarKwh === 0) {
        historyEntry.solar_energy_wh = historyEntry.solar_energy_wh ?? 0;
        historyEntry.solar_power_w = historyEntry.solar_power_w ?? 0;
      }
    }
    if (typeof observedSolarPower === "number" && Number.isFinite(observedSolarPower)) {
      historyEntry.solar_power_w = observedSolarPower;
      if (
        historyEntry.solar_energy_wh === null &&
        typeof firstSolarKwh === "number" &&
        Number.isFinite(firstSolarKwh) &&
        firstSolarKwh === 0
      ) {
        historyEntry.solar_energy_wh = 0;
      }
    }

    const backtestHistoryCandidates = this.storageRef.listHistory(500);
    const backtestResult = this.backtestService.calculate(input.config, {
      history: backtestHistoryCandidates.map((item) => item.payload),
      extraEntries: [historyEntry],
      referenceTimestamp: result.timestamp,
      endValuationPriceEurPerKwh: result.average_price_eur_per_kwh,
    });
    if (backtestResult) {
      snapshot.backtested_savings_eur = backtestResult.savingsEur;
      historyEntry.backtested_savings_eur = backtestResult.savingsEur;
    }

    this.storageRef.replaceSnapshot(structuredClone(snapshot));
    this.storageRef.appendHistory([historyEntry]);

    const historyRecords = this.storageRef.listHistory();
    return {
      ...snapshot,
      history: normalizeHistoryList(historyRecords.map((item) => item.payload)),
    };
  }

  appendErrorsToLatestSnapshot(messages: string[]): void {
    if (!Array.isArray(messages) || messages.length === 0) {
      return;
    }
    const latest = this.storageRef.getLatestSnapshot();
    if (!latest) {
      return;
    }
    const updatedPayload: SnapshotPayload = structuredClone(latest.payload);
    const existing = Array.isArray(updatedPayload.errors) ? [...updatedPayload.errors] : [];
    let changed = false;
    for (const rawMessage of messages) {
      const message = typeof rawMessage === "string" ? rawMessage.trim() : "";
      if (!message) {
        continue;
      }
      if (!existing.includes(message)) {
        existing.push(message);
        changed = true;
      }
    }
    if (!changed) {
      return;
    }
    updatedPayload.errors = existing;
    this.storageRef.replaceSnapshot(updatedPayload);
  }

  private resolveLiveSoc(rawSoc: unknown): number | null {
    const numeric = this.normalizeSoc(rawSoc);
    if (numeric !== null) {
      return numeric;
    }
    const previous = this.storageRef.getLatestSnapshot();
    if (!previous) {
      return null;
    }
    const payload = previous.payload as Partial<SnapshotPayload> | undefined;
    if (!payload) {
      return null;
    }
    const candidates = [
      payload.current_soc_percent,
      payload.next_step_soc_percent,
      payload.recommended_soc_percent,
      payload.recommended_final_soc_percent,
    ];
    for (const candidate of candidates) {
      const value = this.normalizeSoc(candidate);
      if (value !== null) {
        this.logger.warn(`Live SOC missing from inputs; falling back to last snapshot (${value}%)`);
        return value;
      }
    }
    return null;
  }

  private normalizeSoc(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      if (value >= 0 && value <= 100) {
        return value;
      }
      return Math.min(100, Math.max(0, value));
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        return Math.min(100, Math.max(0, numeric));
      }
    }
    return null;
  }
}

function gridFee(cfg: SimulationConfig): number {
  const priceCfg = cfg.price ?? {};
  const value = priceCfg.grid_fee_eur_per_kwh ?? 0;
  return Number(value) || 0;
}

function normalizePriceSlots(raw: RawForecastEntry[]): PriceSlot[] {
  const slotsByStart = new Map<number, TariffSlot>();
  for (const entry of raw) {
    if (!entry) continue;
    const startValue = entry.start ?? entry.from;
    if (!startValue) {
      continue;
    }
    const start = parseTimestamp(startValue);
    if (!start) {
      continue;
    }

    let end = parseTimestamp(entry.end ?? entry.to);
    if (!end) {
      const durationHours = Number(entry.duration_hours ?? entry.durationHours ?? 1);
      const durationMinutes = Number(entry.duration_minutes ?? entry.durationMinutes ?? 0);
      if (!Number.isNaN(durationHours) && durationHours > 0) {
        end = new Date(start.getTime() + durationHours * 3_600_000);
      } else if (!Number.isNaN(durationMinutes) && durationMinutes > 0) {
        end = new Date(start.getTime() + durationMinutes * 60_000);
      } else {
        end = new Date(start.getTime() + 3_600_000);
      }
    }
    if (end.getTime() <= start.getTime()) {
      continue;
    }

    const energyPrice =
      EnergyPrice.tryFromValue(entry.price, entry.unit) ??
      EnergyPrice.tryFromValue(entry.value, entry.value_unit);
    if (!energyPrice) {
      continue;
    }

    const rawEraId = entry.era_id ?? entry.eraId;
    const eraId = typeof rawEraId === "string" && rawEraId.length > 0 ? rawEraId : undefined;
    const slot = TariffSlot.fromDates(start, end, energyPrice, eraId);
    const key = slot.start.getTime();
    const existing = slotsByStart.get(key);
    if (!existing || slot.price < existing.price) {
      slotsByStart.set(key, slot);
    }
  }
  return [...slotsByStart.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

interface SolarSlot {
  start: Date;
  end: Date;
  energy_kwh: number;
}

function normalizeSolarSlots(raw: RawSolarEntry[]): SolarSlot[] {
  const slots: SolarSlot[] = [];
  for (const entry of raw) {
    if (!entry) continue;
    const start = parseTimestamp(entry.start);
    if (!start) {
      continue;
    }
    const end = parseTimestamp(entry.end) ?? new Date(start.getTime() + SLOT_DURATION_MS);
    const energy = Number(entry.energy_kwh ?? 0);
    if (!Number.isFinite(energy) || energy <= 0) {
      continue;
    }
    slots.push({start, end, energy_kwh: energy});
  }

  return slots.sort((a, b) => a.start.getTime() - b.start.getTime());
}

function clampRatio(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  if (numeric <= 0) {
    return 0;
  }
  if (numeric >= 1) {
    return 1;
  }
  return numeric;
}

function computeSlotCost(gridEnergyKwh: number, importPrice: number, feedInTariff: number): number {
  if (!Number.isFinite(gridEnergyKwh) || Number.isNaN(gridEnergyKwh)) {
    return 0;
  }
  const priceImport = Number.isFinite(importPrice) ? importPrice : 0;
  const priceFeedIn = Number.isFinite(feedInTariff) ? feedInTariff : 0;
  if (gridEnergyKwh >= 0) {
    return priceImport * gridEnergyKwh;
  }
  return priceFeedIn * gridEnergyKwh;
}

function buildErasFromSlots(slots: PriceSlot[]): ForecastEra[] {
  return slots.map((slot, index) => {
    const eraId = `${slot.start.getTime()}`;
    const energyPrice = EnergyPrice.fromEurPerKwh(slot.price);
    const costPayload = {
      price_ct_per_kwh: energyPrice.ctPerKwh,
      price_eur_per_kwh: energyPrice.eurPerKwh,
      price_with_fee_ct_per_kwh: energyPrice.ctPerKwh,
      price_with_fee_eur_per_kwh: energyPrice.eurPerKwh,
      unit: "ct/kWh",
    };
    const updatedSlot = slot.withEraId(eraId);
    slots[index] = updatedSlot;
    return {
      era_id: eraId,
      start: updatedSlot.start.toISOString(),
      end: updatedSlot.end.toISOString(),
      duration_hours: updatedSlot.durationHours,
      sources: [
        {
          provider: "awattar",
          type: "cost",
          payload: costPayload,
        },
      ],
    } satisfies ForecastEra;
  });
}

interface SimulationOptions {
  solarGenerationKwhPerSlot?: number[];
  pvDirectUseRatio?: number;
  feedInTariffEurPerKwh?: number;
  allowBatteryExport?: boolean;
  allowGridChargeFromGrid?: boolean;
}

interface SimulationOutput {
  initial_soc_percent: number;
  next_step_soc_percent: number | null;
  recommended_soc_percent: number | null;
  recommended_final_soc_percent: number | null;
  simulation_runs: number;
  projected_cost_eur: number;
  baseline_cost_eur: number;
  projected_savings_eur: number;
  projected_grid_power_w: number;
  average_price_eur_per_kwh: number;
  forecast_samples: number;
  forecast_hours: number;
  oracle_entries: OracleEntry[];
  timestamp: string;
}

function simulateOptimalSchedule(
  cfg: SimulationConfig,
  liveState: { battery_soc?: number | null },
  slots: PriceSlot[],
  options: SimulationOptions = {},
): SimulationOutput {
  if (slots.length === 0) {
    throw new Error("price forecast is empty");
  }

  const capacityKwh = Number(cfg.battery?.capacity_kwh ?? 0);
  if (!(capacityKwh > 0)) {
    throw new Error("battery.capacity_kwh must be > 0");
  }
  const maxChargePowerW = Number(cfg.battery?.max_charge_power_w ?? 0);
  const maxSolarChargePowerW = cfg.battery?.max_charge_power_solar_w != null
    ? Math.max(0, Number(cfg.battery.max_charge_power_solar_w))
    : null;
  const networkTariff = gridFee(cfg);
  const solarGenerationPerSlot = options.solarGenerationKwhPerSlot ?? [];
  const directUseRatio = clampRatio(
    options.pvDirectUseRatio ?? cfg.solar?.direct_use_ratio ?? 0,
  );
  const feedInTariff = Math.max(
    0,
    Number(options.feedInTariffEurPerKwh ?? cfg.price?.feed_in_tariff_eur_per_kwh ?? 0),
  );
  const allowBatteryExport =
    typeof options.allowBatteryExport === "boolean"
      ? options.allowBatteryExport
      : cfg.logic?.allow_battery_export ?? true;
  const allowGridChargeFromGrid =
    typeof options.allowGridChargeFromGrid === "boolean" ? options.allowGridChargeFromGrid : true;

  let currentSoc = Number(liveState.battery_soc ?? 50);
  if (Number.isNaN(currentSoc)) {
    currentSoc = 50;
  }
  currentSoc = Math.min(100, Math.max(0, currentSoc));

  const percentStep = 100 / SOC_STEPS;
  const energyPerStep = capacityKwh / SOC_STEPS;

  const totalDuration = slots.reduce((acc, item) => acc + item.durationHours, 0);
  if (totalDuration <= 0) {
    throw new Error("price forecast has zero duration");
  }

  const avgPrice =
    slots.reduce((acc, slot) => acc + (slot.price + networkTariff) * slot.durationHours, 0) / totalDuration;

  const numStates = SOC_STEPS + 1;
  const horizon = slots.length;
  const dp: number[][] = Array.from({length: horizon + 1}, () =>
    Array.from({length: numStates}, () => Number.POSITIVE_INFINITY),
  );
  const policy: number[][] = Array.from({length: horizon}, () =>
    Array.from({length: numStates}, () => 0),
  );

  for (let state = 0; state < numStates; state += 1) {
    const energy = state * energyPerStep;
    dp[horizon][state] = -avgPrice * energy;
  }

  const houseLoadWatts = cfg.logic?.house_load_w ?? 1200;

  for (let idx = horizon - 1; idx >= 0; idx -= 1) {
    const slot = slots[idx];
    const duration = slot.durationHours;
    const loadEnergy = (houseLoadWatts / 1000) * duration;
    const solarKwh = solarGenerationPerSlot[idx] ?? 0;
    const priceTotal = slot.price + networkTariff;
    const directTarget = Math.max(0, solarKwh * directUseRatio);
    const directUsed = Math.min(loadEnergy, directTarget);
    const loadAfterDirect = loadEnergy - directUsed;
    const availableSolar = Math.max(0, solarKwh - directUsed);

    const gridChargeLimitKwh = allowGridChargeFromGrid && maxChargePowerW > 0 ? (maxChargePowerW / 1000) * duration : 0;
    const solarChargeLimitKwh = (() => {
      if (availableSolar <= 0) {
        return 0;
      }
      if (maxSolarChargePowerW != null) {
        const limit = (maxSolarChargePowerW / 1000) * duration;
        return Math.min(availableSolar, limit);
      }
      return availableSolar;
    })();
    const totalChargeLimitKwh = gridChargeLimitKwh + solarChargeLimitKwh;
    const baselineGridEnergy = loadAfterDirect - availableSolar;
    const baselineGridImport = Math.max(0, baselineGridEnergy);

    for (let state = 0; state < numStates; state += 1) {
      let bestCost = Number.POSITIVE_INFINITY;
      let bestNext = state;

      let maxChargeSteps = numStates - 1 - state;
      if (totalChargeLimitKwh > 0) {
        maxChargeSteps = Math.min(
          maxChargeSteps,
          Math.floor(totalChargeLimitKwh / energyPerStep + 1e-9),
        );
      } else {
        maxChargeSteps = Math.min(maxChargeSteps, 0);
      }
      const upLimit = Math.min(maxChargeSteps, numStates - 1 - state);
      const downLimit = state;

      for (let delta = -downLimit; delta <= upLimit; delta += 1) {
        const nextState = state + delta;
        const energyChange = delta * energyPerStep;
        const gridEnergy = loadAfterDirect + energyChange - availableSolar;
        if (!allowBatteryExport) {
          const minGridEnergy = baselineGridEnergy < 0 ? baselineGridEnergy : 0;
          if (gridEnergy < minGridEnergy - 1e-9) {
            continue;
          }
        }
        if (energyChange > 0) {
          const gridImport = Math.max(0, gridEnergy);
          const additionalGridCharge = Math.max(0, gridImport - baselineGridImport);
          if (additionalGridCharge > gridChargeLimitKwh + 1e-9) {
            continue;
          }
          const solarChargingKwh = Math.max(0, energyChange - additionalGridCharge);
          if (solarChargingKwh > solarChargeLimitKwh + 1e-9) {
            continue;
          }
        }
        const slotCost = computeSlotCost(gridEnergy, priceTotal, feedInTariff);
        const totalCost = slotCost + dp[idx + 1][nextState];
        if (totalCost < bestCost) {
          bestCost = totalCost;
          bestNext = nextState;
        }
      }

      if (!Number.isFinite(bestCost)) {
        bestCost = dp[idx + 1][state];
        bestNext = state;
      }

      dp[idx][state] = bestCost;
      policy[idx][state] = bestNext;
    }
  }

  let currentState = Math.round(currentSoc / percentStep);
  currentState = Math.max(0, Math.min(numStates - 1, currentState));

  const path = [currentState];
  let gridEnergyTotalKwh = 0;
  let gridChargeTotalKwh = 0;
  let costTotal = 0;
  let baselineCost = 0;
  let stateIter = currentState;
  const oracleEntries: OracleEntry[] = [];

  for (let idx = 0; idx < slots.length; idx += 1) {
    const slot = slots[idx];
    const nextState = policy[idx][stateIter];
    const delta = nextState - stateIter;
    const energyChange = delta * energyPerStep;
    const slotDurationHours = slot.durationHours;
    const loadEnergy = (houseLoadWatts / 1000) * slotDurationHours;
    const solarKwh = solarGenerationPerSlot[idx] ?? 0;
    const directTarget = Math.max(0, solarKwh * directUseRatio);
    const directUsed = Math.min(loadEnergy, directTarget);
    const loadAfterDirect = loadEnergy - directUsed;
    const availableSolar = Math.max(0, solarKwh - directUsed);
    const importPrice = slot.price + networkTariff;
    const baselineGridEnergy = loadAfterDirect - availableSolar;
    baselineCost += computeSlotCost(baselineGridEnergy, importPrice, feedInTariff);
    const gridEnergy = loadAfterDirect + energyChange - availableSolar;
    costTotal += computeSlotCost(gridEnergy, importPrice, feedInTariff);
    gridEnergyTotalKwh += gridEnergy;
    const baselineGridImport = Math.max(0, baselineGridEnergy);
    const gridImport = Math.max(0, gridEnergy);
    const additionalGridCharge = energyChange > 0 ? Math.max(0, gridImport - baselineGridImport) : 0;
    if (additionalGridCharge > 0) {
      gridChargeTotalKwh += additionalGridCharge;
    }
    path.push(nextState);
    const solarToLoad = Math.min(availableSolar, loadAfterDirect);
    let remainingSolar = availableSolar - solarToLoad;
    let solarToBattery = 0;
    if (energyChange > 0) {
      solarToBattery = Math.min(remainingSolar, energyChange);
      remainingSolar -= solarToBattery;
    }

    const eraId =
      typeof slot.eraId === "string" && slot.eraId.length > 0
        ? slot.eraId
        : slot.start.toISOString();
    const strategy: OracleEntry["strategy"] = additionalGridCharge > 0.001 ? "charge" : "auto";
    const startSocPercent = stateIter * percentStep;
    const endSocPercent = nextState * percentStep;
    const normalizedGridEnergyWh = Number.isFinite(gridEnergy) ? gridEnergy * 1000 : null;
    oracleEntries.push({
      era_id: eraId,
      start_soc_percent: Number.isFinite(startSocPercent) ? startSocPercent : null,
      end_soc_percent: Number.isFinite(endSocPercent) ? endSocPercent : null,
      target_soc_percent: Number.isFinite(endSocPercent) ? endSocPercent : null,
      grid_energy_wh: normalizedGridEnergyWh,
      strategy,
    });

    stateIter = nextState;
  }

  const finalEnergy = path[path.length - 1] * energyPerStep;
  costTotal -= avgPrice * finalEnergy;
  baselineCost -= avgPrice * finalEnergy;

  const projectedSavings = baselineCost - costTotal;
  const projectedGridPowerW = totalDuration > 0 ? (gridEnergyTotalKwh / totalDuration) * 1000 : 0;

  const shouldChargeFromGrid = gridChargeTotalKwh > 0.001;
  const firstTarget = oracleEntries[0]?.end_soc_percent ?? oracleEntries[0]?.target_soc_percent ?? null;
  const finalTarget =
    oracleEntries[oracleEntries.length - 1]?.end_soc_percent ??
    oracleEntries[oracleEntries.length - 1]?.target_soc_percent ??
    null;
  const recommendedTarget = shouldChargeFromGrid ? 100 : finalTarget;
  const nextStepSocPercent = firstTarget ?? currentState * percentStep;
  return {
    initial_soc_percent: currentState * percentStep,
    next_step_soc_percent: nextStepSocPercent,
    recommended_soc_percent: recommendedTarget,
    recommended_final_soc_percent: recommendedTarget,
    simulation_runs: SOC_STEPS,
    projected_cost_eur: costTotal,
    baseline_cost_eur: baselineCost,
    projected_savings_eur: projectedSavings,
    projected_grid_power_w: projectedGridPowerW,
    average_price_eur_per_kwh: avgPrice,
    forecast_samples: slots.length,
    forecast_hours: totalDuration,
    oracle_entries: oracleEntries,
    timestamp: new Date().toISOString(),
  };
}

function extractForecastFromState(state: unknown): RawForecastEntry[] {
  try {
    const parsed = parseEvccState(state);
    return parsed.forecast;
  } catch (error) {
    void error;
    return [];
  }
}

function extractSolarForecastFromState(state: unknown): RawSolarEntry[] {
  try {
    const parsed = parseEvccState(state);
    return buildSolarForecastFromTimeseries(parsed.solarTimeseries);
  } catch (error) {
    void error;
    return [];
  }
}

export {
  extractForecastFromState,
  extractSolarForecastFromState,
  normalizePriceSlots,
  simulateOptimalSchedule,
};
