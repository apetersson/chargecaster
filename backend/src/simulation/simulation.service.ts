import { Inject, Injectable } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  HistoryPoint,
  HistoryResponse,
  PriceSlot,
  SimulationConfig,
  SnapshotPayload,
  SnapshotSummary,
  TrajectoryPoint,
  TrajectoryResponse,
} from "./types.js";
import { StorageService } from "../storage/storage.service.js";

const SOC_STEPS = 100;

export interface SimulationInput {
  config: SimulationConfig;
  liveState: { battery_soc?: number | null };
  forecast: Record<string, unknown>[];
  warnings?: string[];
  errors?: string[];
  priceSnapshotEurPerKwh?: number | null;
}

@Injectable()
export class SimulationService {
  constructor(@Inject(StorageService) private readonly storageRef: StorageService) {}

  getLatestSnapshot(): SnapshotPayload | null {
    const record = this.storageRef.getLatestSnapshot();
    if (!record) {
      return null;
    }
    const historyRecords = this.storageRef.listHistory();
    const history = this.serializeHistory(historyRecords.map((item) => item.payload));
    return {
      ...(record.payload as unknown as SnapshotPayload),
      history,
    };
  }

  ensureSeedFromFixture(): SnapshotPayload {
    const existing = this.getLatestSnapshot();
    if (existing) {
      return existing;
    }

    const fixturePath = join(process.cwd(), "fixtures", "sample_data.json");
    const raw = JSON.parse(readFileSync(fixturePath, "utf-8")) as Record<string, unknown>;
    const tariffGrid = Number((raw as { tariffGrid?: unknown }).tariffGrid ?? 0.02);

    const config: SimulationConfig = {
      battery: {
        capacity_kwh: 12,
        max_charge_power_w: 500,
        auto_mode_floor_soc: 5,
      },
      price: {
        grid_fee_eur_per_kwh: tariffGrid,
      },
      logic: {
        interval_seconds: 300,
        min_hold_minutes: 20,
        house_load_w: 1200,
      },
      state: {
        path: "./state/state.csv",
      },
    };

    const forecast = extractForecastFromState(raw);
    const liveState = {
      battery_soc: Number((raw as { batterySoc?: unknown }).batterySoc ?? 40),
    };
    return this.runSimulation({ config, liveState, forecast });
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
      projected_grid_energy_kwh: snapshot.projected_grid_energy_kwh,
      forecast_hours: snapshot.forecast_hours,
      forecast_samples: snapshot.forecast_samples,
      warnings: snapshot.warnings ?? [],
      errors: snapshot.errors ?? [],
    };
  }

  getHistory(limit = 96): HistoryResponse {
    const snapshot = this.ensureSeedFromFixture();
    const historyRecords = this.storageRef.listHistory(limit);
    const entries = this.serializeHistory(historyRecords.map((item) => item.payload));
    return {
      generated_at: snapshot.timestamp,
      entries,
    };
  }

  getTrajectory(): TrajectoryResponse {
    const snapshot = this.ensureSeedFromFixture();
    return {
      generated_at: snapshot.timestamp,
      points: Array.isArray(snapshot.trajectory) ? snapshot.trajectory : [],
    };
  }

  runSimulation(input: SimulationInput): SnapshotPayload {
    if (!this.storageRef) {
      throw new Error("Storage service not initialised");
    }
    const slots = normalizePriceSlots(input.forecast);
    const result = simulateOptimalSchedule(input.config, input.liveState, slots);
    const priceSnapshot =
      input.priceSnapshotEurPerKwh ?? result.trajectory[0]?.price_eur_per_kwh ?? null;
    const warnings = Array.isArray(input.warnings) ? [...input.warnings] : [];
    const errors = Array.isArray(input.errors) ? [...input.errors] : [];
    const snapshot: SnapshotPayload = {
      timestamp: result.timestamp,
      interval_seconds: input.config.logic?.interval_seconds ?? null,
      house_load_w: input.config.logic?.house_load_w ?? null,
      current_soc_percent: result.initial_soc_percent,
      next_step_soc_percent: result.next_step_soc_percent,
      recommended_soc_percent: result.recommended_soc_percent,
      recommended_final_soc_percent: result.recommended_final_soc_percent,
      price_snapshot_eur_per_kwh: priceSnapshot,
      projected_cost_eur: result.projected_cost_eur,
      projected_grid_energy_kwh: result.projected_grid_energy_kwh,
      forecast_hours: result.forecast_hours,
      forecast_samples: result.forecast_samples,
      trajectory: result.trajectory,
      history: [],
      warnings,
      errors,
    };

    this.storageRef.replaceSnapshot(snapshot as unknown as Record<string, unknown>);
    this.storageRef.appendHistory([
      {
        timestamp: result.timestamp,
        battery_soc_percent: result.next_step_soc_percent,
        price_eur_per_kwh: priceSnapshot,
      },
    ]);

    const historyRecords = this.storageRef.listHistory();
    return {
      ...snapshot,
      history: this.serializeHistory(historyRecords.map((item) => item.payload)),
    };
  }

  private serializeHistory(history: Record<string, unknown>[]): HistoryPoint[] {
    const entries = history.map((entry) => {
      const timestamp =
        typeof entry.timestamp === "string" && entry.timestamp.length > 0
          ? entry.timestamp
          : new Date().toISOString();
      return {
        timestamp,
        battery_soc_percent: toNullableNumber(
          (entry as { battery_soc_percent?: unknown }).battery_soc_percent,
        ),
        price_eur_per_kwh: toNullableNumber((entry as { price_eur_per_kwh?: unknown }).price_eur_per_kwh),
        grid_power_kw: null,
        grid_energy_kwh: null,
      };
    });
    return entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }
}

function toNullableNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function gridFee(cfg: SimulationConfig): number {
  const priceCfg = cfg.price ?? {};
  const value = priceCfg.grid_fee_eur_per_kwh ?? priceCfg.network_tariff_eur_per_kwh ?? 0;
  return Number(value) || 0;
}

function normalizePriceSlots(raw: Record<string, unknown>[]): PriceSlot[] {
  const slotsByStart = new Map<number, PriceSlot>();
  for (const entry of raw) {
    if (!entry) continue;
    const record = entry as {
      start?: unknown;
      from?: unknown;
      end?: unknown;
      to?: unknown;
      price?: unknown;
      unit?: unknown;
      value?: unknown;
      value_unit?: unknown;
      duration_hours?: unknown;
      durationHours?: unknown;
      duration_minutes?: unknown;
      durationMinutes?: unknown;
    };
    const startValue = record.start ?? record.from;
    const endValue = record.end ?? record.to;
    const priceValue = normalizePriceValue(record.price, record.unit) ?? normalizePriceValue(record.value, record.value_unit);
    if (!startValue || priceValue == null) {
      continue;
    }
    const start = parseTimestamp(startValue);
    if (!start) {
      continue;
    }
    let end = endValue ? parseTimestamp(endValue) : null;
    if (!end) {
      const durationHours = Number(record.duration_hours ?? record.durationHours ?? 1);
      const durationMinutes = Number(record.duration_minutes ?? record.durationMinutes ?? 0);
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
    const slot: PriceSlot = {
      start,
      end,
      durationHours,
      price: priceValue,
    };
    const key = start.getTime();
    const existing = slotsByStart.get(key);
    if (!existing || slot.price < existing.price) {
      slotsByStart.set(key, slot);
    }
  }
  return [...slotsByStart.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
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

interface SimulationOutput {
  initial_soc_percent: number;
  next_step_soc_percent: number;
  recommended_soc_percent: number;
  recommended_final_soc_percent: number;
  simulation_runs: number;
  projected_cost_eur: number;
  projected_grid_energy_kwh: number;
  average_price_eur_per_kwh: number;
  forecast_samples: number;
  forecast_hours: number;
  trajectory: TrajectoryPoint[];
  price_floor_eur_per_kwh: number;
  price_ceiling_eur_per_kwh: number;
  timestamp: string;
}

function simulateOptimalSchedule(
  cfg: SimulationConfig,
  liveState: { battery_soc?: number | null },
  slots: PriceSlot[],
): SimulationOutput {
  if (slots.length === 0) {
    throw new Error("price forecast is empty");
  }

  const capacityKwh = Number(cfg.battery?.capacity_kwh ?? 0);
  if (!(capacityKwh > 0)) {
    throw new Error("battery.capacity_kwh must be > 0");
  }
  const maxChargePowerW = Number(cfg.battery?.max_charge_power_w ?? 0);
  const networkTariff = gridFee(cfg);

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
    const chargeLimitKwh = (maxChargePowerW / 1000) * duration;
    const priceTotal = slot.price + networkTariff;

    const maxChargeSteps = Math.floor(chargeLimitKwh / energyPerStep + 1e-9);
    const maxDischargeSteps = Math.floor(loadEnergy / energyPerStep + 1e-9);

    for (let state = 0; state < numStates; state += 1) {
      let bestCost = Number.POSITIVE_INFINITY;
      let bestNext = state;

      const upLimit = Math.min(maxChargeSteps, numStates - 1 - state);
      const downLimit = Math.min(maxDischargeSteps, state);

      for (let delta = -downLimit; delta <= upLimit; delta += 1) {
        const nextState = state + delta;
        const energyChange = delta * energyPerStep;
        const gridEnergy = loadEnergy + energyChange;
        if (gridEnergy < -1e-9) {
          continue;
        }
        const slotCost = priceTotal * Math.max(gridEnergy, 0);
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
  let gridEnergyTotal = 0;
  let costTotal = 0;
  let stateIter = currentState;
  const trajectory: TrajectoryPoint[] = [];

  for (let idx = 0; idx < slots.length; idx += 1) {
    const slot = slots[idx];
    const nextState = policy[idx][stateIter];
    const delta = nextState - stateIter;
    const energyChange = delta * energyPerStep;
    const loadEnergy = (houseLoadWatts / 1000) * slot.durationHours;
    let gridEnergy = loadEnergy + energyChange;
    if (gridEnergy < 0) gridEnergy = 0;
    costTotal += (slot.price + networkTariff) * gridEnergy;
    gridEnergyTotal += gridEnergy;
    path.push(nextState);
    trajectory.push({
      slot_index: idx,
      start: slot.start.toISOString(),
      end: slot.end.toISOString(),
      duration_hours: slot.durationHours,
      soc_start_percent: stateIter * percentStep,
      soc_end_percent: nextState * percentStep,
      grid_energy_kwh: gridEnergy,
      price_eur_per_kwh: slot.price + networkTariff,
    });
    stateIter = nextState;
  }

  const finalEnergy = path[path.length - 1] * energyPerStep;
  costTotal -= avgPrice * finalEnergy;

  const nextState = path[1] ?? path[0];
  const recommendedTarget = path[path.length - 1] * percentStep;

  return {
    initial_soc_percent: currentState * percentStep,
    next_step_soc_percent: nextState * percentStep,
    recommended_soc_percent: recommendedTarget,
    recommended_final_soc_percent: recommendedTarget,
    simulation_runs: SOC_STEPS,
    projected_cost_eur: costTotal,
    projected_grid_energy_kwh: gridEnergyTotal,
    average_price_eur_per_kwh: avgPrice,
    forecast_samples: slots.length,
    forecast_hours: totalDuration,
    trajectory,
    price_floor_eur_per_kwh: Math.min(...trajectory.map((t) => t.price_eur_per_kwh)),
    price_ceiling_eur_per_kwh: Math.max(...trajectory.map((t) => t.price_eur_per_kwh)),
    timestamp: new Date().toISOString(),
  };
}

function extractForecastFromState(state: Record<string, unknown>): Record<string, unknown>[] {
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
  const entries: Record<string, unknown>[] = [];
  for (const seq of sequences) {
    if (!Array.isArray(seq)) continue;
    for (const entry of seq) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as {
        start?: unknown;
        from?: unknown;
        end?: unknown;
        to?: unknown;
        value?: unknown;
        price?: unknown
      };
      const start = record.start ?? record.from;
      const end = record.end ?? record.to;
      const price = record.value ?? record.price;
      if (start && price != null) {
        entries.push({start, end, price});
      }
    }
  }
  return entries;
}

export { extractForecastFromState, normalizePriceSlots, simulateOptimalSchedule };
