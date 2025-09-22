import { describe, expect, it } from "vitest";

import { simulateOptimalSchedule } from "../src/simulation/simulation.service.ts";
import type { PriceSlot, SimulationConfig } from "../src/simulation/types.ts";

function createSlot(hour: number, price: number): PriceSlot {
  const start = new Date(Date.UTC(2025, 0, 1, hour, 0, 0));
  const end = new Date(Date.UTC(2025, 0, 1, hour + 1, 0, 0));
  return {
    start,
    end,
    durationHours: 1,
    price,
    eraId: `era-${hour}`,
  };
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
    house_load_w: 1500,
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
        pvDirectUseRatio: 0,
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

    expect(first.grid_power_w).not.toBeNull();
    if (first.grid_power_w !== null) {
      expect(first.grid_power_w).toBeGreaterThan(0);
    }

    if (first.grid_power_w !== null && first.grid_energy_kwh !== null) {
      const expectedEnergy = (first.grid_power_w / 1000) * slots[0].durationHours;
      expect(first.grid_energy_kwh).toBeCloseTo(expectedEnergy, 6);
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
        house_load_w: 1000,
      },
      solar: {
        direct_use_ratio: 0.2,
      },
    };

    const slots: PriceSlot[] = [createSlot(2, 0.32), createSlot(3, 0.35)];
    const solar = [1.8, 0.2];

    const result = simulateOptimalSchedule(
      config,
      { battery_soc: 80 },
      slots,
      {
        solarGenerationKwhPerSlot: solar,
        pvDirectUseRatio: 0.2,
      },
    );

    expect(result.oracle_entries).toHaveLength(2);
    const first = result.oracle_entries[0];
    expect(first.strategy).toBe("auto");
    expect(first.grid_power_w).not.toBeNull();
    if (first.grid_power_w !== null) {
      expect(first.grid_power_w).toBeLessThanOrEqual(0);
    }

    if (result.next_step_soc_percent !== null && first.end_soc_percent !== null) {
      expect(first.end_soc_percent).toBeCloseTo(result.next_step_soc_percent, 6);
    }
  });
});
