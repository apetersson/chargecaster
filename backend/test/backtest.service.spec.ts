import { describe, expect, it } from "vitest";

import { computeBacktestedSavings } from "../src/simulation/backtest.service";
import type { HistoryPoint, SimulationConfig } from "../src/simulation/types";

describe("computeBacktestedSavings", () => {
  const baseConfig: SimulationConfig = {
    battery: {
      capacity_kwh: 10,
      max_charge_power_w: 5000,
      auto_mode_floor_soc: 20,
    },
    price: {
      feed_in_tariff_eur_per_kwh: 0.05,
      grid_fee_eur_per_kwh: 0.0,
    },
    logic: {
      interval_seconds: 1800,
      min_hold_minutes: 0,
      house_load_w: 0,
    },
  };

  it("returns savings based on a single interval", () => {
    const history: HistoryPoint[] = [
      {
        timestamp: "2025-01-01T08:00:00.000Z",
        battery_soc_percent: 50,
        price_eur_per_kwh: 0.3,
        price_ct_per_kwh: 30,
        grid_power_w: 1000,
        solar_power_w: 2000,
        solar_energy_wh: null,
        home_power_w: null,
        backtested_savings_eur: null,
      },
      {
        timestamp: "2025-01-01T08:30:00.000Z",
        battery_soc_percent: 55,
        price_eur_per_kwh: 0.3,
        price_ct_per_kwh: 30,
        grid_power_w: 500,
        solar_power_w: 1500,
        solar_energy_wh: null,
        home_power_w: null,
        backtested_savings_eur: null,
      },
    ];

    const result = computeBacktestedSavings(baseConfig, history, {
      referenceTimestamp: history[1].timestamp,
      windowHours: 1,
    });

    expect(result).not.toBeNull();
    if (!result) {
      return;
    }

    expect(result.intervalCount).toBe(1);
    expect(result.actualCostEur).toBeCloseTo(0.15, 6);
    expect(result.dumbCostEur).toBeCloseTo(0, 6);
    expect(result.savingsEur).toBeCloseTo(-0.15, 6);
  });

  it("returns null when capacity is missing", () => {
    const config: SimulationConfig = {
      ...baseConfig,
      battery: {
        ...baseConfig.battery,
        capacity_kwh: 0,
      },
    };
    const history: HistoryPoint[] = [];
    const result = computeBacktestedSavings(config, history);
    expect(result).toBeNull();
  });
});
