import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Inject, Injectable, Logger } from "@nestjs/common";
import type {
  DemandForecastEntry,
  ForecastEra,
  HistoryPoint,
  PriceSlot,
  RawForecastEntry,
  RawSolarEntry,
  SimulationConfig,
  SnapshotPayload,
} from "@chargecaster/domain";
import {
  Duration,
  Energy,
  EnergyPrice,
  TimeSlot,
  normalizePriceSlots,
} from "@chargecaster/domain";
import { StorageService } from "../storage/storage.service";
import { parseEvccState } from "../config/schemas";
import { normalizeHistoryList } from "./history.serializer";
import { BatteryEfficiencyService } from "./battery-efficiency.service";
import { buildSolarForecastFromTimeseries, parseTimestamp } from "./solar";
import { gridFee, simulateOptimalSchedule } from "./optimal-schedule";

const DEFAULT_SLOT_DURATION = Duration.fromHours(1);

export interface SimulationInput {
  config: SimulationConfig;
  liveState: { battery_soc?: number | null };
  forecast: RawForecastEntry[];
  warnings?: string[];
  errors?: string[];
  priceSnapshotEurPerKwh?: number | null;
  solarForecast?: RawSolarEntry[];
  forecastEras?: ForecastEra[];
  demandForecast?: DemandForecastEntry[];
  observations?: {
    gridPowerW?: number | null;
    solarPowerW?: number | null;
    homePowerW?: number | null;
    evChargePowerW?: number | null;
    siteDemandPowerW?: number | null;
  };
}

interface SolarDiscrepancySample {
  start: string;
  end: string | null;
  calibratedPowerW: number;
  proxyPowerW: number;
}

interface PeakSolarDiscrepancy {
  watts: number;
  start: string;
  end: string | null;
}

@Injectable()
export class SimulationService {
  private readonly logger = new Logger(SimulationService.name);

  constructor(
    @Inject(StorageService) private readonly storageRef: StorageService,
    @Inject(BatteryEfficiencyService) private readonly batteryEfficiencyRef: BatteryEfficiencyService,
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
    if (existing && existing.forecast_eras.length > 0) {
      return existing;
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
        allow_battery_export: true,
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
    // Normalise live telemetry so downstream optimisers always receive a concrete SoC
    // Ensure the optimiser always receives a deterministic SoC input
    const resolvedSoCPercent = this.resolveLiveSoCPercent(input.liveState.battery_soc);
    const liveState = {battery_soc: resolvedSoCPercent};
    const slots = normalizePriceSlots(input.forecast);
    const solarSlots = normalizeSolarSlots(input.solarForecast ?? []);
    const demandSlots = normalizeDemandForecastSlots(input.demandForecast ?? []);
    const warnings = [...(input.warnings ?? [])];
    const errors = [...(input.errors ?? [])];
    const forecastErasInput = input.forecastEras ?? [];
    const warningCount = warnings.length;
    const errorCount = errors.length;
    const forecastEraCount = forecastErasInput.length;
    this.logger.log(
      `Running simulation with forecast_slots=${slots.length}, solar_slots=${solarSlots.length}, live_soc=${
        liveState.battery_soc ?? "n/a"
      }`,
    );
    this.logger.verbose(
      `Simulation inputs: warnings=${warningCount}, errors=${errorCount}, ` +
      `price_snapshot=${input.priceSnapshotEurPerKwh ?? "n/a"}, forecast_eras=${forecastEraCount}`,
    );

    // Distribute solar energy into each price slot proportionally to the time overlap.
    // This fixes the 1h solar vs 15m tariff slot mismatch (avoids 4x inflation).
    // Bucket the solar forecast onto the pricing cadence so the optimiser sees consistent inputs
    const solarEnergyPerSlot = slots.map((priceSlot) => {
      const priceSlotWindow = TimeSlot.fromDates(priceSlot.start, priceSlot.end);
      return solarSlots.reduce((total, sample) => {
        const overlap = priceSlotWindow.overlapDuration(sample.slot);
        if (overlap.milliseconds === 0) {
          return total;
        }
        const fraction = overlap.ratioOf(sample.slot.duration);
        return total.add(sample.energy.scale(fraction));
      }, Energy.zero());
    });

    const solarGenerationPerSlotKwh = solarEnergyPerSlot.map((energy) => energy.kilowattHours);
    const feedInTariff = Math.max(0, Number(input.config.price.feed_in_tariff_eur_per_kwh ?? 0));
    const batteryEfficiency = this.batteryEfficiencyRef.estimateRecentEfficiencies(
      Energy.fromKilowattHours(Number(input.config.battery.capacity_kwh ?? 0)),
    );
    const peakSolarDiscrepancy = computePeakSolarForecastDiscrepancy(input.solarForecast ?? []);
    const demandProfilePerSlot = slots.map((priceSlot) => {
      const priceSlotWindow = TimeSlot.fromDates(priceSlot.start, priceSlot.end);
      return demandSlots.reduce((acc, sample) => {
        const overlap = priceSlotWindow.overlapDuration(sample.slot);
        if (overlap.milliseconds === 0) {
          return acc;
        }
        const ratio = overlap.ratioOf(priceSlotWindow.duration).value;
        acc.house += sample.housePowerW * ratio;
        acc.coverage += ratio;
        return acc;
      }, { house: 0, coverage: 0 });
    }).map((entry) => ({
      housePowerW: entry.coverage > 0 ? entry.house : null,
    }));

    // Run the DP-based optimiser with the caller's grid and export preferences
    const result = simulateOptimalSchedule(input.config, liveState, slots, {
      solarGenerationKwhPerSlot: solarGenerationPerSlotKwh,
      houseLoadWattsPerSlot: demandProfilePerSlot.map((entry) => entry.housePowerW ?? undefined),
      feedInTariffEurPerKwh: feedInTariff,
      allowBatteryExport: input.config.logic.allow_battery_export ?? true,
      chargeEfficiency: batteryEfficiency.chargeEfficiency,
      dischargeEfficiency: batteryEfficiency.dischargeEfficiency,
    });
    const initialSoCPercent = result.initial_soc_percent;
    const nextSoCPercent = result.next_step_soc_percent ?? initialSoCPercent;
    const firstEntry = result.oracle_entries.length > 0 ? result.oracle_entries[0] : null;
    const firstStrategy = firstEntry?.strategy ?? null;
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
          const strategyLabel = entry.strategy.toUpperCase();
          if (entry.strategy !== "hold") {
            return `${strategyLabel}@${entry.era_id}`;
          }
          const holdLevel = normalizeSocLabel(entry.target_soc_percent ?? entry.start_soc_percent ?? entry.end_soc_percent);
          return holdLevel ? `${strategyLabel}@${entry.era_id} (SoC ${holdLevel})` : `${strategyLabel}@${entry.era_id}`;
        })
        .join("\n");
      this.logger.verbose(`Era strategies:\n${strategyLog}`);
    }
    const fallbackPrice = slots.length
      ? EnergyPrice.fromEurPerKwh(slots[0].price).withAdditionalFee(gridFee(input.config))
      : null;
    const priceSnapshot = input.priceSnapshotEurPerKwh != null
      ? EnergyPrice.fromEurPerKwh(input.priceSnapshotEurPerKwh)
      : fallbackPrice;
    const priceSnapshotEur = priceSnapshot?.eurPerKwh ?? null;
    const priceSnapshotCt = priceSnapshot?.ctPerKwh ?? null;
    const fallbackEras = buildErasFromSlots(slots);
    const forecastEras = forecastErasInput.length ? forecastErasInput : fallbackEras;
    // Run a second pass that mimics "auto" mode (no active grid charging) for comparison
    const autoResult = simulateOptimalSchedule(input.config, liveState, slots, {
      solarGenerationKwhPerSlot: solarGenerationPerSlotKwh,
      houseLoadWattsPerSlot: demandProfilePerSlot.map((entry) => entry.housePowerW ?? undefined),
      feedInTariffEurPerKwh: feedInTariff,
      allowBatteryExport: input.config.logic.allow_battery_export ?? true,
      allowGridChargeFromGrid: false,
      chargeEfficiency: batteryEfficiency.chargeEfficiency,
      dischargeEfficiency: batteryEfficiency.dischargeEfficiency,
    });
    // Assemble the API snapshot expected by the frontend and storage layers
    const snapshot: SnapshotPayload = {
      timestamp: result.timestamp,
      interval_seconds: input.config.logic.interval_seconds ?? null,
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
      active_control_savings_eur: Number.isFinite(autoResult.projected_cost_eur) && Number.isFinite(result.projected_cost_eur)
        ? autoResult.projected_cost_eur - result.projected_cost_eur
        : null,
      projected_grid_power_w: result.projected_grid_power_w,
      solar_forecast_discrepancy_w: peakSolarDiscrepancy?.watts ?? null,
      solar_forecast_discrepancy_start: peakSolarDiscrepancy?.start,
      solar_forecast_discrepancy_end: peakSolarDiscrepancy?.end ?? undefined,
      forecast_hours: result.forecast_hours,
      forecast_samples: result.forecast_samples,
      forecast_eras: forecastEras,
      demand_forecast: input.demandForecast ?? [],
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
      solar_forecast_power_w: null,
      solar_energy_wh: null,
      home_power_w: null,
      ev_charge_power_w: null,
      site_demand_power_w: null,
    };

    const observedGridPower = input.observations?.gridPowerW;
    if (observedGridPower != null) {
      historyEntry.grid_power_w = observedGridPower;
    }

    const firstSolarEnergy = solarEnergyPerSlot[0] ?? Energy.zero();
    const firstSolarWh = firstSolarEnergy.wattHours;
    const firstSlot = slots.length > 0 ? slots[0] : null;
    const observedSolarPower = input.observations?.solarPowerW;
    if (firstSlot) {
      if (firstSolarWh > 0) {
        historyEntry.solar_energy_wh = firstSolarWh;
        const slotDuration = firstSlot.duration;
        if (slotDuration.hours > 0) {
          historyEntry.solar_forecast_power_w = firstSolarEnergy.per(slotDuration).watts;
          historyEntry.solar_power_w = historyEntry.solar_forecast_power_w;
        }
      } else if (firstSolarWh === 0) {
        historyEntry.solar_energy_wh = historyEntry.solar_energy_wh ?? 0;
        historyEntry.solar_forecast_power_w = historyEntry.solar_forecast_power_w ?? 0;
        historyEntry.solar_power_w = historyEntry.solar_power_w ?? 0;
      }
    }
    if (observedSolarPower != null) {
      historyEntry.solar_power_w = observedSolarPower;
      if (
        historyEntry.solar_energy_wh === null &&
        firstSolarWh === 0
      ) {
        historyEntry.solar_energy_wh = 0;
      }
    }

    const observedHomePower = input.observations?.homePowerW;
    if (observedHomePower != null) {
      historyEntry.home_power_w = observedHomePower;
    }

    const observedEvChargePower = input.observations?.evChargePowerW;
    if (observedEvChargePower != null) {
      historyEntry.ev_charge_power_w = observedEvChargePower;
    }

    const observedSiteDemandPower = input.observations?.siteDemandPowerW;
    if (observedSiteDemandPower != null) {
      historyEntry.site_demand_power_w = observedSiteDemandPower;
    } else if (historyEntry.home_power_w != null) {
      historyEntry.site_demand_power_w = historyEntry.home_power_w + Math.max(0, historyEntry.ev_charge_power_w ?? 0);
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
    if (messages.length === 0) {
      return;
    }
    const latest = this.storageRef.getLatestSnapshot();
    if (!latest) {
      return;
    }
    const updatedPayload: SnapshotPayload = structuredClone(latest.payload);
    const existing = [...updatedPayload.errors];
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

function computePeakSolarForecastDiscrepancy(solarForecast: RawSolarEntry[]): PeakSolarDiscrepancy | null {
  const samples = solarForecast
    .map(toSolarDiscrepancySample)
    .filter((sample): sample is SolarDiscrepancySample => sample !== null);
  if (!samples.length) {
    return null;
  }
  const strongest = samples.reduce((currentStrongest, sample) => {
    const delta = sample.calibratedPowerW - sample.proxyPowerW;
    if (currentStrongest === null || Math.abs(delta) > Math.abs(currentStrongest.watts)) {
      return {
        watts: delta,
        start: sample.start,
        end: sample.end,
      };
    }
    return currentStrongest;
  }, null as PeakSolarDiscrepancy | null);
  if (!strongest) {
    return null;
  }
  return {
    ...strongest,
    watts: Number(strongest.watts.toFixed(3)),
  };
}

function toSolarDiscrepancySample(entry: RawSolarEntry): SolarDiscrepancySample | null {
  const start = parseTimestamp(entry.start ?? entry.ts ?? null);
  if (!start) {
    return null;
  }
  const end = parseTimestamp(entry.end ?? null);
  const durationHours = end && end.getTime() > start.getTime()
    ? (end.getTime() - start.getTime()) / 3_600_000
    : 1;
  if (!Number.isFinite(durationHours) || durationHours <= 0) {
    return null;
  }

  const calibratedPowerW = resolveFiniteNumber(entry.calibrated_power_w)
    ?? inferSolarAveragePower(entry, durationHours);
  const proxyPowerW = resolveFiniteNumber(entry.proxy_power_w);
  if (calibratedPowerW === null || proxyPowerW === null) {
    return null;
  }

  return {
    start: start.toISOString(),
    end: end?.toISOString() ?? null,
    calibratedPowerW,
    proxyPowerW,
  };
}

function inferSolarAveragePower(entry: RawSolarEntry, durationHours: number): number | null {
  if (durationHours <= 0) {
    return null;
  }
  const energyWh = resolveFiniteNumber(entry.energy_wh)
    ?? (resolveFiniteNumber(entry.energy_kwh) != null ? (entry.energy_kwh as number) * 1000 : null);
  return energyWh == null ? null : energyWh / durationHours;
}

function resolveFiniteNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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

interface SolarSlot {
  slot: TimeSlot;
  energy: Energy;
}

interface DemandSlot {
  slot: TimeSlot;
  housePowerW: number;
}

function normalizeSolarSlots(raw: RawSolarEntry[]): SolarSlot[] {
  const slots: SolarSlot[] = [];
  for (const entry of raw) {
    const start = parseTimestamp(entry.start);
    if (!start) {
      continue;
    }
    const end = parseTimestamp(entry.end);
    const slotTime = end && end.getTime() > start.getTime()
      ? TimeSlot.fromDates(start, end)
      : TimeSlot.fromStartAndDuration(start, DEFAULT_SLOT_DURATION);
    const rawEnergyKwh = (() => {
      if (typeof entry.energy_kwh === "number") {
        return entry.energy_kwh;
      }
      if (typeof entry.energy_wh === "number") {
        return entry.energy_wh / 1000;
      }
      return null;
    })();
    if (rawEnergyKwh == null) {
      continue;
    }
    const energy = Number(rawEnergyKwh);
    if (!Number.isFinite(energy) || energy <= 0) {
      continue;
    }
    slots.push({slot: slotTime, energy: Energy.fromKilowattHours(energy)});
  }

  return slots.sort((a, b) => a.slot.start.getTime() - b.slot.start.getTime());
}

function normalizeDemandForecastSlots(raw: DemandForecastEntry[]): DemandSlot[] {
  const slots: DemandSlot[] = [];
  for (const entry of raw) {
    const start = parseTimestamp(entry.start);
    if (!start) {
      continue;
    }
    const end = parseTimestamp(entry.end);
    const slotTime = end && end.getTime() > start.getTime()
      ? TimeSlot.fromDates(start, end)
      : TimeSlot.fromStartAndDuration(start, DEFAULT_SLOT_DURATION);
    slots.push({
      slot: slotTime,
      housePowerW: entry.house_power_w,
    });
  }
  return slots.sort((left, right) => left.slot.start.getTime() - right.slot.start.getTime());
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
  simulateOptimalSchedule,
};
