import { Inject, Injectable, Logger } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { JsonObject } from "../common/json.ts";
import type {
  ForecastEra,
  ForecastResponse,
  HistoryResponse,
  OracleEntry,
  OracleResponse,
  PriceSlot,
  RawForecastEntry,
  RawSolarEntry,
  SimulationConfig,
  SnapshotPayload,
  SnapshotSummary,
} from "./types.ts";
import { normalizeHistoryList } from "./history.serializer.ts";
import { StorageService } from "../storage/storage.service.ts";

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

  constructor(@Inject(StorageService) private readonly storageRef: StorageService) {
  }

  getLatestSnapshot(): SnapshotPayload | null {
    const record = this.storageRef.getLatestSnapshot();
    if (!record) {
      return null;
    }
    const payload = record.payload as unknown as SnapshotPayload;
    const oracleEntries = Array.isArray(payload.oracle_entries) ? payload.oracle_entries : [];
    payload.oracle_entries = oracleEntries;
    const historyRecords = this.storageRef.listHistory();
    const history = normalizeHistoryList(historyRecords.map((item) => item.payload));
    return {
      ...payload,
      history,
    };
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

  ensureSeedFromFixture(): SnapshotPayload {
    const existing = this.getLatestSnapshot();
    if (existing) {
      const hasForecast = Array.isArray(existing.forecast_eras) && existing.forecast_eras.length > 0;
      if (hasForecast) {
        return existing;
      }
    }

    const fixturePath = join(process.cwd(), "fixtures", "sample_data.json");
    const raw = JSON.parse(readFileSync(fixturePath, "utf-8")) as JsonObject;
    const tariffGrid = Number((raw as { tariffGrid?: unknown }).tariffGrid ?? 0.02);

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
      state: {
        path: "./state/state.csv",
      },
    };

    const forecast = extractForecastFromState(raw);
    const solarForecast = extractSolarForecastFromState(raw);
    const liveState = {
      battery_soc: Number((raw as { batterySoc?: unknown }).batterySoc ?? 40),
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
      price_snapshot_eur_per_kwh: snapshot.price_snapshot_eur_per_kwh,
      projected_cost_eur: snapshot.projected_cost_eur,
      baseline_cost_eur: snapshot.baseline_cost_eur,
      basic_battery_cost_eur: snapshot.basic_battery_cost_eur,
      projected_savings_eur: snapshot.projected_savings_eur,
      projected_grid_energy_w: snapshot.projected_grid_energy_w,
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
    const liveState = { battery_soc: resolvedSoc };
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
    const mode = result.recommended_soc_percent === 100 ? "CHARGE" : "AUTO";
    this.logger.log(`Simulation result: ${mode}`);
    if (result.oracle_entries.length) {
      const strategyLog = result.oracle_entries
        .map((entry) => `${(entry.strategy ?? "auto").toUpperCase()}@${entry.era_id}`)
        .join(", ");
      this.logger.log(`Era strategies: ${strategyLog}`);
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
      price_snapshot_ct_per_kwh: priceSnapshotCt,
      price_snapshot_eur_per_kwh: priceSnapshotEur,
      projected_cost_eur: result.projected_cost_eur,
     baseline_cost_eur: result.baseline_cost_eur,
     basic_battery_cost_eur: autoResult.projected_cost_eur,
      projected_savings_eur: result.projected_savings_eur,
      active_control_savings_eur: autoResult.projected_cost_eur !== null && result.projected_cost_eur !== null
        ? autoResult.projected_cost_eur - result.projected_cost_eur
        : null,
      projected_grid_energy_w: result.projected_grid_energy_w,
      forecast_hours: result.forecast_hours,
      forecast_samples: result.forecast_samples,
      forecast_eras: hasProvidedEras ? input.forecastEras! : fallbackEras,
      oracle_entries: result.oracle_entries,
      history: [],
      warnings,
      errors,
    };

    this.storageRef.replaceSnapshot(JSON.parse(JSON.stringify(snapshot)) as JsonObject);
    const historyEntry: JsonObject = {
      timestamp: result.timestamp,
      battery_soc_percent: result.initial_soc_percent,
      price_eur_per_kwh: priceSnapshotEur,
      price_ct_per_kwh: priceSnapshotCt,
    };

    const observedGridPower = input.observations?.gridPowerW;
    if (typeof observedGridPower === "number" && Number.isFinite(observedGridPower)) {
      historyEntry.grid_power_w = observedGridPower;
    }

    const firstOracle = result.oracle_entries[0];
    if (firstOracle) {
      if (typeof firstOracle.grid_power_w === "number" && Number.isFinite(firstOracle.grid_power_w)) {
        if (!("grid_power_w" in historyEntry)) {
          historyEntry.grid_power_w = firstOracle.grid_power_w;
        }
      }
      if (typeof firstOracle.grid_energy_kwh === "number" && Number.isFinite(firstOracle.grid_energy_kwh)) {
        historyEntry.grid_energy_wh = firstOracle.grid_energy_kwh * 1000;
      }
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
        if (!("solar_energy_wh" in historyEntry)) {
          historyEntry.solar_energy_wh = 0;
        }
        if (!("solar_power_w" in historyEntry)) {
          historyEntry.solar_power_w = 0;
        }
      }
    }
    if (typeof observedSolarPower === "number" && Number.isFinite(observedSolarPower)) {
      historyEntry.solar_power_w = observedSolarPower;
      if (!("solar_energy_wh" in historyEntry) && typeof firstSolarKwh === "number" && Number.isFinite(firstSolarKwh) && firstSolarKwh === 0) {
        historyEntry.solar_energy_wh = 0;
      }
    }

    this.storageRef.appendHistory([historyEntry]);

    const historyRecords = this.storageRef.listHistory();
    return {
      ...snapshot,
      history: normalizeHistoryList(historyRecords.map((item) => item.payload)),
    };
  }
}

function gridFee(cfg: SimulationConfig): number {
  const priceCfg = cfg.price ?? {};
  const value = priceCfg.grid_fee_eur_per_kwh ?? priceCfg.network_tariff_eur_per_kwh ?? 0;
  return Number(value) || 0;
}

function normalizePriceSlots(raw: RawForecastEntry[]): PriceSlot[] {
  const slotsByStart = new Map<number, PriceSlot>();
  for (const entry of raw) {
    if (!entry) continue;
    const startValue = entry.start ?? entry.from;
    const endValue = entry.end ?? entry.to;
    const priceValue =
      normalizePriceValue(entry.price, entry.unit) ?? normalizePriceValue(entry.value, entry.value_unit);
    if (!startValue || priceValue == null) {
      continue;
    }
    const start = parseTimestamp(startValue);
    if (!start) {
      continue;
    }
    let end = endValue ? parseTimestamp(endValue) : null;
    if (!end) {
      const durationHours = Number(entry.duration_hours ?? entry.durationHours ?? 1);
      const durationMinutes = Number(entry.duration_minutes ?? entry.durationMinutes ?? 0);
      if (!Number.isNaN(durationHours) && durationHours > 0) {
        end = new Date(start.getTime() + durationHours * 3600_000);
      } else if (!Number.isNaN(durationMinutes) && durationMinutes > 0) {
        end = new Date(start.getTime() + durationMinutes * 60_000);
      } else {
        end = new Date(start.getTime() + 3600_000);
      }
    }
    if (end.getTime() <= start.getTime()) {
      continue;
    }
    const durationHours = (end.getTime() - start.getTime()) / 3600_000;
    const rawEraId = entry.era_id ?? entry.eraId;
    const eraId = typeof rawEraId === "string" && rawEraId.length > 0 ? rawEraId : undefined;
    const slot: PriceSlot = {
      start,
      end,
      durationHours,
      price: priceValue,
      eraId,
    };
    const key = start.getTime();
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
  return slots.map((slot) => {
    const eraId = `${slot.start.getTime()}`;
    const durationHours = slot.durationHours;
    const priceCt = Number.isFinite(slot.price) ? slot.price * 100 : null;
    const payload: JsonObject = {};
    if (priceCt !== null) {
      payload.price_ct_per_kwh = priceCt;
      payload.unit = "ct/kWh";
    } else {
      payload.price = slot.price;
    }
    slot.eraId = eraId;
    return {
      era_id: eraId,
      start: slot.start.toISOString(),
      end: slot.end.toISOString(),
      duration_hours: durationHours,
      sources: [
        {
          provider: "awattar",
          type: "cost",
          payload,
        },
      ],
    } satisfies ForecastEra;
  });
}

function normalizePriceValue(value: unknown, unit: unknown): number | null {
  if (value == null) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const unitStr = typeof unit === "string" ? unit.toLowerCase() : "";
  if (!unitStr || unitStr === "eur/kwh" || unitStr === "€/kwh") {
    return numeric;
  }
  if (unitStr === "ct/kwh" || unitStr === "ct/wh" || unitStr === "cent/kwh") {
    return numeric / 100;
  }
  if (unitStr === "eur/mwh" || unitStr === "€/mwh") {
    return numeric / 1000;
  }
  return numeric;
}

function parseTimestamp(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "number") {
    return new Date(value);
  }
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return null;
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
  projected_grid_energy_w: number;
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
  const maxSolarChargePowerW = cfg.solar?.max_charge_power_w != null
    ? Math.max(0, Number(cfg.solar.max_charge_power_w))
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

    const durationForPower = slotDurationHours > 0 ? slotDurationHours : 1;
    const gridPowerW = durationForPower > 0 ? (gridEnergy / durationForPower) * 1000 : 0;
    const eraId =
      typeof slot.eraId === "string" && slot.eraId.length > 0
        ? slot.eraId
        : slot.start.toISOString();
    const strategy: "charge" | "auto" = additionalGridCharge > 0.001 ? "charge" : "auto";
    const startSocPercent = stateIter * percentStep;
    const endSocPercent = nextState * percentStep;
    const normalizedGridPower = Number.isFinite(gridPowerW) ? gridPowerW : null;
    const normalizedGridEnergy = Number.isFinite(gridEnergy) ? gridEnergy : null;
    oracleEntries.push({
      era_id: eraId,
      start_soc_percent: Number.isFinite(startSocPercent) ? startSocPercent : null,
      end_soc_percent: Number.isFinite(endSocPercent) ? endSocPercent : null,
      target_soc_percent: Number.isFinite(endSocPercent) ? endSocPercent : null,
      grid_power_w: normalizedGridPower,
      grid_energy_kwh: normalizedGridEnergy,
      grid_energy_w: normalizedGridPower,
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
    projected_grid_energy_w: projectedGridPowerW,
    average_price_eur_per_kwh: avgPrice,
    forecast_samples: slots.length,
    forecast_hours: totalDuration,
    oracle_entries: oracleEntries,
    timestamp: new Date().toISOString(),
  };
}

function extractForecastFromState(state: JsonObject): RawForecastEntry[] {
  const forecast = (state as { forecast?: unknown }).forecast;
  if (!forecast) return [];
  const sequences: unknown[] = [];
  if (Array.isArray(forecast)) {
    sequences.push(forecast);
  } else if (typeof forecast === "object" && forecast !== null) {
    for (const value of Object.values(forecast)) {
      if (Array.isArray(value)) {
        sequences.push(value);
      }
    }
  }
  const entries: RawForecastEntry[] = [];
  for (const seq of sequences) {
    if (!Array.isArray(seq)) continue;
    for (const entry of seq) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as RawForecastEntry;
      const start = record.start ?? record.from;
      const end = record.end ?? record.to;
      const price = record.value ?? record.price;
      if (start && price != null) {
        entries.push({ start, end, price } as RawForecastEntry);
      }
    }
  }
  return entries;
}

function extractSolarForecastFromState(state: JsonObject): RawSolarEntry[] {
  const asRecord = (value: unknown): JsonObject | null =>
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as JsonObject)
      : null;

  const forecastRecord = asRecord((state as { forecast?: unknown }).forecast);
  if (!forecastRecord) {
    return [];
  }

  const solarRecord = asRecord(forecastRecord.solar);
  const timeseries = Array.isArray(solarRecord?.timeseries)
    ? (solarRecord?.timeseries as unknown[])
    : [];

  const entries: RawSolarEntry[] = [];
  for (let index = 0; index < timeseries.length; index += 1) {
    const item = asRecord(timeseries[index]);
    if (!item) {
      continue;
    }

    const start = parseTimestamp((item.ts ?? item.start ?? item.from) ?? null);
    if (!start) {
      continue;
    }

    const next = index + 1 < timeseries.length ? asRecord(timeseries[index + 1]) : null;
    const end =
      parseTimestamp((next?.ts ?? next?.end ?? next?.to) ?? null) ??
      new Date(start.getTime() + SLOT_DURATION_MS);

    const durationMs = end.getTime() - start.getTime();
    if (!(durationMs > 0)) {
      continue;
    }

    let energyKwh = resolveNumeric(item.energy_kwh);
    if (energyKwh === null) {
      const energyWh = resolveNumeric(item.energy_wh);
      if (energyWh !== null) {
        energyKwh = energyWh / 1000;
      }
    }

    if (energyKwh === null) {
      const rawPower = resolveNumeric(item.value ?? item.val);
      if (rawPower !== null) {
        let powerKw = rawPower / 1000;
        if (!Number.isFinite(powerKw)) {
          powerKw = 0;
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
    } as RawSolarEntry);
  }

  return entries;
}

function resolveNumeric(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
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

export {
  extractForecastFromState,
  extractSolarForecastFromState,
  normalizePriceSlots,
  simulateOptimalSchedule,
};
