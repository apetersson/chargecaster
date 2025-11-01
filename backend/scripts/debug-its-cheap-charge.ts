import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { SimulationConfig } from "@chargecaster/domain";

import { parseEvccState } from "../src/config/schemas";
import { buildSolarForecastFromTimeseries, parseTimestamp } from "../src/simulation/solar";
import { normalizePriceSlots, simulateOptimalSchedule } from "../src/simulation/simulation.service";

function resolveFixturePath(): string {
  const fixtureName = "its_cheap_charge_ffs.json";
  const candidates = [
    join(process.cwd(), "fixtures", fixtureName),
    join(process.cwd(), "backend", "fixtures", fixtureName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Fixture ${fixtureName} not found in: ${candidates.join(", ")}`);
}

function loadConfigFromLocalConfig(): SimulationConfig {
  return {
    battery: {
      capacity_kwh: 10,
      max_charge_power_w: 500,
      max_charge_power_solar_w: 4500,
      auto_mode_floor_soc: 5,
      max_discharge_power_w: 4500,
      max_charge_soc_percent: 96,
    },
    price: {
      grid_fee_eur_per_kwh: 0.11,
      feed_in_tariff_eur_per_kwh: 0.038,
    },
    logic: {
      min_hold_minutes: 0,
      interval_seconds: 300,
      house_load_w: 2200,
      allow_battery_export: false,
    },
    solar: {
      direct_use_ratio: 0.6,
    },
  };
}

function main(): void {
  const fixturePath = resolveFixturePath();
  const raw: unknown = JSON.parse(readFileSync(fixturePath, "utf-8"));
  const parsed = parseEvccState(raw);
  const slots = normalizePriceSlots(parsed.forecast);
  const solarForecast = buildSolarForecastFromTimeseries(parsed.solarTimeseries);

  const SLOT_MS = 3_600_000;
  const solarMap = new Map<number, number>();
  for (const sample of solarForecast) {
    const start = parseTimestamp(sample.start);
    if (!start) {
      continue;
    }
    const energy = Number(sample.energy_kwh ?? 0);
    if (!Number.isFinite(energy) || energy <= 0) {
      continue;
    }
    const key = Math.floor(start.getTime() / SLOT_MS);
    solarMap.set(key, (solarMap.get(key) ?? 0) + energy);
  }

  const solarGenerationKwhPerSlot = slots.map((slot) => {
    const key = Math.floor(slot.start.getTime() / SLOT_MS);
    return solarMap.get(key) ?? 0;
  });

  const config = loadConfigFromLocalConfig();
  const houseLoadKwhPerSlot = slots.map((slot) => (config.logic.house_load_w ?? 0) / 1000 * slot.durationHours);
  const slotInsights = slots.map((slot, index) => {
    const durationHours = slot.durationHours;
    const solarGen = solarGenerationKwhPerSlot[index] ?? 0;
    const directUse = Math.min(
      houseLoadKwhPerSlot[index] ?? 0,
      solarGen * (config.solar?.direct_use_ratio ?? 0),
    );
    const loadAfterDirectUse = (houseLoadKwhPerSlot[index] ?? 0) - directUse;
    const availableSolar = Math.max(0, solarGen - directUse);
    const baselineGridEnergy = loadAfterDirectUse - availableSolar;
    return {
      idx: index,
      start: slot.start.toISOString(),
      price: slot.price,
      durationHours,
      solarGen,
      directUse,
      loadAfterDirectUse,
      availableSolar,
      baselineGridEnergy,
    };
  });

  const result = simulateOptimalSchedule(
    config,
    {battery_soc: parsed.batterySoc ?? 40},
    slots,
    {
      solarGenerationKwhPerSlot,
      pvDirectUseRatio: config.solar?.direct_use_ratio ?? 0,
      feedInTariffEurPerKwh: config.price.feed_in_tariff_eur_per_kwh ?? 0,
      allowBatteryExport: config.logic.allow_battery_export ?? true,
    },
  );

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        initial_soc: result.initial_soc_percent,
        next_soc: result.next_step_soc_percent,
        projected_cost: result.projected_cost_eur,
        baseline_cost: result.baseline_cost_eur,
        entries: result.oracle_entries.slice(0, 12),
        slot_insights: slotInsights.slice(0, 12),
      },
      null,
      2,
    ),
  );

  const SOC_STEPS = 100;
  const EPSILON = 1e-9;
  const WATTS_PER_KW = 1000;
  const energyPerStepKwh = (config.battery.capacity_kwh ?? 0) / SOC_STEPS;
  const socPercentStep = 100 / SOC_STEPS;
  const minSocPercent = config.battery.auto_mode_floor_soc ?? 0;
  let minAllowedSoCStep = Math.max(0, Math.ceil(minSocPercent / socPercentStep - EPSILON));
  const maxChargePercent = config.battery.max_charge_soc_percent ?? 100;
  const maxAllowedSoCStep = Math.round(maxChargePercent / socPercentStep);
  if (minAllowedSoCStep > maxAllowedSoCStep) {
    minAllowedSoCStep = maxAllowedSoCStep;
  }
  const currentSoCStep = Math.max(
    0,
    Math.min(SOC_STEPS, Math.round((result.initial_soc_percent ?? 0) / socPercentStep)),
  );
  const profile0 = slotInsights[0];
  if (profile0) {
    const durationHours = profile0.durationHours;
    const gridChargeLimitKwh = (config.battery.max_charge_power_w ?? 0) / WATTS_PER_KW * durationHours;
    const solarChargeLimitKwh = profile0.availableSolar;
    const baselineGridImport = Math.max(0, profile0.baselineGridEnergy);
    // eslint-disable-next-line no-console
    console.log("First slot transition feasibility");
    for (let deltaSteps = 0; deltaSteps <= 10; deltaSteps += 1) {
      const nextSoCStep = currentSoCStep + deltaSteps;
      if (nextSoCStep > maxAllowedSoCStep) {
        break;
      }
      const energyChange = deltaSteps * energyPerStepKwh;
      const gridEnergy = profile0.loadAfterDirectUse + energyChange - profile0.availableSolar;
      const gridImport = Math.max(0, gridEnergy);
      const additionalGrid = Math.max(0, gridImport - baselineGridImport);
      const solarPossible = Math.min(energyChange, solarChargeLimitKwh, Math.max(0, profile0.availableSolar));
      const maxGridNeeded = Math.max(0, energyChange - solarPossible);
      const flags = {
        deltaSteps,
        energyChange,
        gridEnergy,
        gridImport,
        baselineGridImport,
        additionalGrid,
        maxGridNeeded,
        gridChargeLimitKwh,
        allowed: additionalGrid <= maxGridNeeded + EPSILON && additionalGrid <= gridChargeLimitKwh + EPSILON,
      };
      // eslint-disable-next-line no-console
      console.log(flags);
    }
  }
}

main();
