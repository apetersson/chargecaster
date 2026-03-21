import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EnergyPrice, Percentage, normalizePriceSlots, TariffSlot } from "@chargecaster/domain";

import type { PriceSlot, SimulationConfig } from "@chargecaster/domain";
import { parseEvccState } from "../src/config/schemas";
import { buildSolarForecastFromTimeseries, parseTimestamp } from "../src/simulation/solar";
import { simulateOptimalSchedule } from "../src/simulation/simulation.service";

function createSlot(hour: number, price: number): PriceSlot {
  const start = new Date(Date.UTC(2025, 0, 1, hour, 0, 0));
  const end = new Date(Date.UTC(2025, 0, 1, hour + 1, 0, 0));
  return TariffSlot.fromDates(start, end, EnergyPrice.fromEurPerKwh(price), `era-${hour}`);
}

const baseConfig: SimulationConfig = {
  battery: {
    capacity_kwh: 12,
    max_charge_power_w: 5000,
    auto_mode_floor_soc: 10,
  },
  price: {
    grid_fee_eur_per_kwh: 0.02,
  },
  logic: {
    interval_seconds: 300,
    min_hold_minutes: 0,
  },
};

describe("simulateOptimalSchedule oracle output", () => {
  it("flags grid charging with end-of-era SOC", () => {
    const config: SimulationConfig = {
      ...baseConfig,
      battery: {
        ...baseConfig.battery,
        max_charge_power_w: 3500,
      },
    };

    const slots: PriceSlot[] = [createSlot(0, 0.08), createSlot(1, 0.38)];
    const result = simulateOptimalSchedule(
      config,
      { battery_soc: 40 },
      slots,
      {
        solarGenerationKwhPerSlot: [0, 0],
        houseLoadWattsPerSlot: [1500, 1500],
      },
    );

    expect(result.oracle_entries).toHaveLength(2);
    const first = result.oracle_entries[0];
    expect(first.strategy).toBe("charge");
    expect(first.start_soc_percent).not.toBeNull();
    expect(first.end_soc_percent).not.toBeNull();

    if (first.start_soc_percent !== null && first.end_soc_percent !== null) {
      expect(first.end_soc_percent).toBeGreaterThan(first.start_soc_percent);
    }

    expect(first.grid_energy_wh).not.toBeNull();
    if (first.grid_energy_wh !== null) {
      expect(first.grid_energy_wh).toBeGreaterThan(0);
      const durationHours = slots[0].durationHours;
      const derivedPower = first.grid_energy_wh / durationHours;
      expect(derivedPower).toBeGreaterThan(0);
    }

    if (result.next_step_soc_percent !== null && first.end_soc_percent !== null) {
      expect(result.next_step_soc_percent).toBeCloseTo(first.end_soc_percent, 6);
    }
  });

  it("handles solar surplus with auto strategy and matches next-step SOC", () => {
    const config: SimulationConfig = {
      ...baseConfig,
      battery: {
        ...baseConfig.battery,
        max_charge_power_w: 0,
      },
      logic: {
        ...baseConfig.logic,
      },
    };

    const slots: PriceSlot[] = [createSlot(2, 0.32), createSlot(3, 0.35)];
    const solarGenerationPerSlotKwh = [1.8, 0.2];

    const result = simulateOptimalSchedule(
      config,
      { battery_soc: 80 },
      slots,
      {
        solarGenerationKwhPerSlot: solarGenerationPerSlotKwh,
        houseLoadWattsPerSlot: [1000, 1000],
      },
    );

    expect(result.oracle_entries).toHaveLength(2);
    const first = result.oracle_entries[0];
    expect(["auto", "hold"]).toContain(first.strategy);
    expect(first.grid_energy_wh).not.toBeNull();
    if (first.grid_energy_wh !== null) {
      const durationHours = slots[0].durationHours;
      const derivedPower = first.grid_energy_wh / durationHours;
      expect(derivedPower).toBeLessThanOrEqual(0);
    }

    if (result.next_step_soc_percent !== null && first.end_soc_percent !== null) {
      expect(first.end_soc_percent).toBeCloseTo(result.next_step_soc_percent, 6);
    }
  });

  it("reduces stored SoC gain when charge efficiency is below 100%", () => {
    const capacityKwh = 10;
    const config: SimulationConfig = {
      ...baseConfig,
      battery: {
        capacity_kwh: capacityKwh,
        max_charge_power_w: 1000,
        auto_mode_floor_soc: 10,
      },
      logic: {
        ...baseConfig.logic,
      },
    };
    const slots: PriceSlot[] = [createSlot(0, 0.08), createSlot(1, 0.38)];

    const efficientResult = simulateOptimalSchedule(
      config,
      { battery_soc: 50 },
      slots,
      {
        solarGenerationKwhPerSlot: [0, 0],
        houseLoadWattsPerSlot: [0, 0],
        chargeEfficiency: Percentage.full(),
        dischargeEfficiency: Percentage.full(),
      },
    );
    const lossyResult = simulateOptimalSchedule(
      config,
      { battery_soc: 50 },
      slots,
      {
        solarGenerationKwhPerSlot: [0, 0],
        houseLoadWattsPerSlot: [0, 0],
        chargeEfficiency: Percentage.fromRatio(0.8),
        dischargeEfficiency: Percentage.full(),
      },
    );

    expect(efficientResult.oracle_entries[0]?.strategy).toBe("charge");
    expect(lossyResult.oracle_entries[0]?.strategy).toBe("charge");
    const efficientGridEnergyKwh = (efficientResult.oracle_entries[0]?.grid_energy_wh ?? 0) / 1000;
    const lossyGridEnergyKwh = (lossyResult.oracle_entries[0]?.grid_energy_wh ?? 0) / 1000;
    const efficientExpectedSoc = Math.round(50 + (efficientGridEnergyKwh / capacityKwh) * 100);
    const lossyExpectedSoc = Math.round(50 + (lossyGridEnergyKwh * 0.8 / capacityKwh) * 100);

    expect(efficientResult.next_step_soc_percent).toBe(efficientExpectedSoc);
    expect(lossyResult.next_step_soc_percent).toBe(lossyExpectedSoc);
    if (lossyResult.next_step_soc_percent != null && efficientResult.next_step_soc_percent != null) {
      expect(lossyResult.next_step_soc_percent).toBeLessThan(efficientResult.next_step_soc_percent);
    }
  });

  it("prefers grid charging for the its_cheap_charge_ffs snapshot", () => {
    const fixtureName = "its_cheap_charge_ffs.json";
    const projectRoot = process.cwd();
    const candidatePaths = [
      join(projectRoot, "fixtures", fixtureName),
      join(projectRoot, "backend", "fixtures", fixtureName),
    ];
    const fixturePath = candidatePaths.find((path) => existsSync(path));
    if (!fixturePath) {
      throw new Error(`Fixture not found in ${candidatePaths.join(", ")}`);
    }

    const raw: unknown = JSON.parse(readFileSync(fixturePath, "utf-8"));
    const parsed = parseEvccState(raw);
    const slots = normalizePriceSlots(parsed.forecast);
    expect(slots.length).toBeGreaterThan(0);

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

    const config: SimulationConfig = {
      battery: {
        capacity_kwh: 10,
        max_charge_power_w: 500,
        auto_mode_floor_soc: 5,
        max_charge_power_solar_w: 4500,
        max_discharge_power_w: 4500,
        max_charge_soc_percent: 96,
      },
      price: {
        grid_fee_eur_per_kwh: 0.11,
        feed_in_tariff_eur_per_kwh: 0.038,
      },
      logic: {
        interval_seconds: 300,
        min_hold_minutes: 0,
        allow_battery_export: false,
      },
    };

    const result = simulateOptimalSchedule(
      config,
      { battery_soc: parsed.batterySoc ?? 40 },
      slots,
      {
        solarGenerationKwhPerSlot,
        houseLoadWattsPerSlot: slots.map(() => 2200),
        feedInTariffEurPerKwh: config.price.feed_in_tariff_eur_per_kwh ?? 0,
        allowBatteryExport: config.logic.allow_battery_export ?? true,
      },
    );

    expect(result.oracle_entries.length).toBeGreaterThan(0);
    const firstEntry = result.oracle_entries[0];
    expect(firstEntry.strategy).toBe("charge");
  });
});
