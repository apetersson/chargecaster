import { Inject, Injectable, Logger } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ForecastEra,
  HistoryPoint,
  PriceSlot,
  RawForecastEntry,
  RawSolarEntry,
  SimulationConfig,
  SnapshotPayload,
} from "./types";
import { normalizeHistoryList } from "./history.serializer";
import { StorageService } from "../storage/storage.service";
import { BacktestSavingsService } from "./backtest.service";
import { buildSolarForecastFromTimeseries, parseTimestamp } from "./solar";
import { parseEvccState } from "../config/schemas";
import { EnergyPrice, TariffSlot } from "@chargecaster/domain";
import { clampRatio, gridFee, simulateOptimalSchedule } from "./optimal-schedule";

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
    homePowerW?: number | null;
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

  // Removed legacy getters (getSummary/getHistory/getForecast/getOracle).
  // Dedicated services now handle these responsibilities (SummaryService, HistoryService, ForecastService, OracleService).

  runSimulation(input: SimulationInput): SnapshotPayload {
    if (!this.storageRef) {
      throw new Error("Storage service not initialised");
    }
    // Normalise live telemetry so downstream optimisers always receive a concrete SoC
    // Ensure the optimiser always receives a deterministic SoC input
    const resolvedSoCPercent = this.resolveLiveSoCPercent(input.liveState?.battery_soc);
    const liveState = {battery_soc: resolvedSoCPercent};
    const slots = normalizePriceSlots(input.forecast);
    const solarSlots = normalizeSolarSlots(input.solarForecast ?? []);

    // Distribute solar energy into each price slot proportionally to the time overlap.
    // This fixes the 1h solar vs 15m tariff slot mismatch (avoids 4x inflation).
    // Bucket the solar forecast onto the pricing cadence so the optimiser sees consistent inputs
    const solarGenerationPerSlotKwh = slots.map((priceSlot) => {
      const eraStart = priceSlot.start.getTime();
      const eraEnd = priceSlot.end.getTime();
      let energyKwh = 0;
      for (const solarSlot of solarSlots) {
        const solarStart = solarSlot.start.getTime();
        const solarEnd = solarSlot.end.getTime();
        const overlapMs = Math.max(0, Math.min(eraEnd, solarEnd) - Math.max(eraStart, solarStart));
        if (overlapMs <= 0) continue;
        const solarMs = Math.max(1, solarEnd - solarStart);
        const fraction = overlapMs / solarMs;
        energyKwh += Math.max(0, solarSlot.energy_kwh) * fraction;
      }
      return energyKwh;
    });

    const directUseRatio = clampRatio(input.config.solar?.direct_use_ratio ?? 0);
    const feedInTariff = Math.max(0, Number(input.config.price?.feed_in_tariff_eur_per_kwh ?? 0));

    // Run the DP-based optimiser with the caller's grid and export preferences
    const result = simulateOptimalSchedule(input.config, liveState, slots, {
      solarGenerationKwhPerSlot: solarGenerationPerSlotKwh,
      pvDirectUseRatio: directUseRatio,
      feedInTariffEurPerKwh: feedInTariff,
      allowBatteryExport: input.config.logic?.allow_battery_export ?? true,
    });
    const initialSoCPercent = result.initial_soc_percent;
    const nextSoCPercent = result.next_step_soc_percent ?? initialSoCPercent;
    const firstStrategy = result.oracle_entries[0]?.strategy ?? null;
    let currentMode: "charge" | "auto" | "hold";
    if (firstStrategy) {
      currentMode = firstStrategy;
    } else if (nextSoCPercent > initialSoCPercent + 0.5) {
      currentMode = "charge";
    } else if (Math.abs(nextSoCPercent - initialSoCPercent) <= 0.5) {
      currentMode = "hold";
    } else {
      currentMode = "auto";
    }
    this.logger.log(`Simulation result: ${currentMode.toUpperCase()}`);
    if (result.oracle_entries.length) {
      const strategyLog = result.oracle_entries
        .map((entry) => {
          const strategyLabel = (entry.strategy ?? "auto").toUpperCase();
          if (entry.strategy !== "hold") {
            return `${strategyLabel}@${entry.era_id}`;
          }
          const holdLevel = normalizeSocLabel(entry.target_soc_percent ?? entry.start_soc_percent ?? entry.end_soc_percent);
          return holdLevel ? `${strategyLabel}@${entry.era_id} (SoC ${holdLevel})` : `${strategyLabel}@${entry.era_id}`;
        })
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
    // Run a second pass that mimics "auto" mode (no active grid charging) for comparison
    const autoResult = simulateOptimalSchedule(input.config, liveState, slots, {
      solarGenerationKwhPerSlot: solarGenerationPerSlotKwh,
      pvDirectUseRatio: directUseRatio,
      feedInTariffEurPerKwh: feedInTariff,
      allowBatteryExport: input.config.logic?.allow_battery_export ?? true,
      allowGridChargeFromGrid: false,
    });
    // Assemble the API snapshot expected by the frontend and storage layers
    const snapshot: SnapshotPayload = {
      timestamp: result.timestamp,
      interval_seconds: input.config.logic?.interval_seconds ?? null,
      house_load_w: input.config.logic?.house_load_w ?? null,
      solar_direct_use_ratio: directUseRatio,
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
      home_power_w: null,
      backtested_savings_eur: null,
    };

    const observedGridPower = input.observations?.gridPowerW;
    if (typeof observedGridPower === "number" && Number.isFinite(observedGridPower)) {
      historyEntry.grid_power_w = observedGridPower;
    }

    const firstSolarKwh = solarGenerationPerSlotKwh[0];
    const firstSlot = slots[0];
    const observedSolarPower = input.observations?.solarPowerW;
    if (Number.isFinite(firstSolarKwh) && firstSlot) {
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
        historyEntry.solar_energy_wh === null && Number.isFinite(firstSolarKwh) &&
        firstSolarKwh === 0
      ) {
        historyEntry.solar_energy_wh = 0;
      }
    }

    const observedHomePower = input.observations?.homePowerW;
    if (typeof observedHomePower === "number" && Number.isFinite(observedHomePower)) {
      historyEntry.home_power_w = observedHomePower;
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
      const message = rawMessage.trim();
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

  private resolveLiveSoCPercent(rawSoc: unknown): number | null {
    const numeric = this.normalizeSoCPercent(rawSoc);
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
      const value = this.normalizeSoCPercent(candidate);
      if (value !== null) {
        this.logger.warn(`Live SOC missing from inputs; falling back to last snapshot (${value}%)`);
        return value;
      }
    }
    return null;
  }

  private normalizeSoCPercent(value: unknown): number | null {
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

function normalizeSocLabel(value: number | null | undefined): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const bounded = Math.min(100, Math.max(0, value));
  const rounded = Math.round(bounded * 10) / 10;
  if (Number.isInteger(rounded)) {
    return `${Math.trunc(rounded)}%`;
  }
  return `${rounded.toFixed(1)}%`;
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

function extractForecastFromState(state: unknown): RawForecastEntry[] {
  try {
    const parsed = parseEvccState(state);
    return parsed.forecast;
  } catch (error) {
    void error;
    return [];
  }
}

// Removed unused helper extractSolarForecastFromState (no external references).

export {
  extractForecastFromState,
  normalizePriceSlots,
  simulateOptimalSchedule,
};
