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

interface SunnySpotLimitFixture {
  live_state: {
    battery_soc: number;
  };
  slots: {
    start: string;
    end: string;
    era_id: string;
    price_eur_per_kwh: number;
  }[];
  feed_in_tariff_eur_per_kwh_by_slot: number[];
  solar_generation_kwh_per_slot: number[];
  house_load_watts_per_slot: number[];
}

function loadSunnySpotLimitFixture(): SunnySpotLimitFixture {
  const fixturePath = join(process.cwd(), "test", "fixtures", "sunny-spot-limit-scenario.json");
  return JSON.parse(readFileSync(fixturePath, "utf-8")) as SunnySpotLimitFixture;
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
        max_charge_power_solar_w: 0,
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
    expect(result.expected_feed_in_kwh).toBeGreaterThan(0);
    expect(first.grid_energy_wh).not.toBeNull();
    if (first.grid_energy_wh !== null) {
      const durationHours = slots[0].durationHours;
      const derivedPower = first.grid_energy_wh / durationHours;
      expect(derivedPower).toBeLessThanOrEqual(0);
    }
    const expectedFeedInKwh = result.oracle_entries.reduce((total, entry) => {
      const gridEnergyWh = entry.grid_energy_wh ?? 0;
      return gridEnergyWh < 0 ? total + Math.abs(gridEnergyWh) / 1000 : total;
    }, 0);
    expect(result.expected_feed_in_kwh).toBeCloseTo(expectedFeedInKwh, 6);

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

  it("tempers aggressive 4 kW grid charging when LiFePO4 efficiency degrades at higher C-rate", () => {
    const slots: PriceSlot[] = [createSlot(0, 0.08), createSlot(1, 0.14)];
    const sharedOptions = {
      solarGenerationKwhPerSlot: [0, 0],
      houseLoadWattsPerSlot: [1000, 1000],
      chargeEfficiency: Percentage.fromRatio(0.95),
      dischargeEfficiency: Percentage.fromRatio(0.95),
    };

    const withoutChemistry = simulateOptimalSchedule(
      {
        ...baseConfig,
        battery: {
          capacity_kwh: 10,
          max_charge_power_w: 4000,
          auto_mode_floor_soc: 5,
          max_charge_soc_percent: 100,
        },
      },
      {battery_soc: 20},
      slots,
      sharedOptions,
    );

    const withLifepo4 = simulateOptimalSchedule(
      {
        ...baseConfig,
        battery: {
          capacity_kwh: 10,
          chemistry: "lifepo4",
          max_charge_power_w: 4000,
          auto_mode_floor_soc: 5,
          max_charge_soc_percent: 100,
        },
      },
      {battery_soc: 20},
      slots,
      sharedOptions,
    );

    expect(withoutChemistry.oracle_entries[0]?.strategy).toBe("charge");
    expect(withLifepo4.oracle_entries[0]?.strategy).toBe("charge");
    expect(withoutChemistry.next_step_soc_percent).toBeGreaterThan(withLifepo4.next_step_soc_percent ?? 0);
    expect(withoutChemistry.oracle_entries[0]?.end_soc_percent).toBeGreaterThan(
      withLifepo4.oracle_entries[0]?.end_soc_percent ?? 0,
    );
  });

  it("keeps PV-led charging in auto while sunny-spot still changes the economics", () => {
    const slots: PriceSlot[] = [createSlot(0, 0.18), createSlot(1, 0.18), createSlot(2, 0.30)];
    const config: SimulationConfig = {
      battery: {
        capacity_kwh: 10,
        max_charge_power_w: 4000,
        max_charge_power_solar_w: 4000,
        max_discharge_power_w: 4000,
        auto_mode_floor_soc: 5,
        max_charge_soc_percent: 100,
      },
      price: {
        grid_fee_eur_per_kwh: 0,
        feed_in_tariff_eur_per_kwh: 0,
      },
      logic: {
        interval_seconds: 300,
        min_hold_minutes: 0,
        allow_battery_export: true,
      },
    };
    const sharedOptions = {
      solarGenerationKwhPerSlot: [3.5, 3.5, 0],
      houseLoadWattsPerSlot: [500, 500, 2000],
      allowBatteryExport: true,
    };

    const sunny = simulateOptimalSchedule(
      config,
      {battery_soc: 40},
      slots,
      {
        ...sharedOptions,
        feedInTariffEurPerKwhBySlot: [0.02, 0.02, 0.02],
      },
    );
    const sunnySpot = simulateOptimalSchedule(
      config,
      {battery_soc: 40},
      slots,
      {
        ...sharedOptions,
        feedInTariffEurPerKwhBySlot: [0.12, 0.01, 0.01],
      },
    );

    expect(sunny.oracle_entries[0]?.strategy).toBe("auto");
    expect(sunnySpot.oracle_entries[0]?.strategy).toBe("auto");
    expect(sunny.oracle_entries[0]?.grid_energy_wh).toBe(0);
    expect(sunnySpot.oracle_entries[0]?.grid_energy_wh).toBe(0);
    expect(sunny.oracle_entries[0]?.end_soc_percent).toBeGreaterThan(sunny.oracle_entries[0]?.start_soc_percent ?? 0);
    expect(sunnySpot.oracle_entries[0]?.end_soc_percent).toBeGreaterThan(
      sunnySpot.oracle_entries[0]?.start_soc_percent ?? 0,
    );
    expect(sunnySpot.next_step_soc_percent).toBe(sunny.next_step_soc_percent);
    expect(sunnySpot.projected_cost_eur).toBeCloseTo(sunny.projected_cost_eur, 6);
    expect(sunnySpot.projected_savings_eur).toBeLessThan(sunny.projected_savings_eur);
    expect(sunnySpot.baseline_cost_eur).toBeLessThan(sunny.baseline_cost_eur);
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

  it("discharges through the valuable morning export window and refills from later solar", () => {
    const fixture = loadSunnySpotLimitFixture();
    const config: SimulationConfig = {
      battery: {
        capacity_kwh: 10,
        max_charge_power_w: 3000,
        auto_mode_floor_soc: 5,
        max_charge_power_solar_w: 3000,
        max_discharge_power_w: 3000,
        max_charge_soc_percent: 100,
      },
      price: {
        grid_fee_eur_per_kwh: 0,
        feed_in_tariff_eur_per_kwh: 0,
      },
      logic: {
        interval_seconds: 300,
        min_hold_minutes: 0,
        allow_battery_export: true,
      },
    };

    const slots: PriceSlot[] = fixture.slots.map((slot) =>
      TariffSlot.fromDates(
        new Date(slot.start),
        new Date(slot.end),
        EnergyPrice.fromEurPerKwh(slot.price_eur_per_kwh),
        slot.era_id,
      )
    );
    const result = simulateOptimalSchedule(
      config,
      fixture.live_state,
      slots,
      {
        solarGenerationKwhPerSlot: fixture.solar_generation_kwh_per_slot,
        houseLoadWattsPerSlot: fixture.house_load_watts_per_slot,
        feedInTariffEurPerKwhBySlot: fixture.feed_in_tariff_eur_per_kwh_by_slot,
        allowBatteryExport: true,
      },
    );

    expect(result.oracle_entries).toHaveLength(fixture.slots.length);
    expect(result.expected_feed_in_kwh).toBeGreaterThan(0);
    expect(result.projected_grid_power_w).toBeLessThan(0);
    expect(result.oracle_entries[0]?.end_soc_percent).toBeLessThan(result.oracle_entries[0]?.start_soc_percent ?? 100);
    expect(result.oracle_entries[1]?.end_soc_percent).toBeLessThanOrEqual(
      result.oracle_entries[0]?.end_soc_percent ?? 100,
    );
    expect(result.oracle_entries[1]?.end_soc_percent).toBe(5);
    expect(result.oracle_entries[2]?.end_soc_percent).toBeGreaterThan(result.oracle_entries[1]?.end_soc_percent ?? 0);
    expect(result.oracle_entries[3]?.end_soc_percent).toBeGreaterThan(result.oracle_entries[2]?.end_soc_percent ?? 0);
    expect(result.oracle_entries[4]?.end_soc_percent).toBeGreaterThan(result.oracle_entries[3]?.end_soc_percent ?? 0);
    expect(result.oracle_entries.slice(0, 5).every((entry) => (entry.grid_energy_wh ?? 0) <= 0)).toBe(true);
    expect(result.oracle_entries[5]?.end_soc_percent).toBe(100);
  });
});
