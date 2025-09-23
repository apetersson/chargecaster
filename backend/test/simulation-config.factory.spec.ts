import { describe, expect, it } from "vitest";

import { SimulationConfigFactory } from "../src/config/simulation-config.factory";
import type { ConfigDocument } from "../src/config/schemas";

const factory = new SimulationConfigFactory();

describe("SimulationConfigFactory", () => {
  it("normalises numeric fields and ratios", () => {
    const config = {
      battery: {
        capacity_kwh: "12",
        max_charge_power_w: 5000,
        auto_mode_floor_soc: 15,
        max_charge_power_solar_w: 2500,
      },
      price: {
        grid_fee_eur_per_kwh: "0.03",
        feed_in_tariff_eur_per_kwh: 0.08,
      },
      logic: {
        interval_seconds: 600,
        min_hold_minutes: 20,
        house_load_w: 1800,
        allow_battery_export: false,
      },
      solar: {
        direct_use_ratio: 1.2,
      },
    } as unknown as ConfigDocument;

    const result = factory.create(config);

    expect(result.battery.capacity_kwh).toBe(12);
    expect(result.battery.auto_mode_floor_soc).toBe(15);
    expect(result.price.grid_fee_eur_per_kwh).toBe(0.03);
    expect(result.logic.interval_seconds).toBe(600);
    expect(result.solar?.direct_use_ratio).toBe(1);
  });

  it("provides interval helper", () => {
    const config = factory.create({} as ConfigDocument);
    expect(factory.getIntervalSeconds(config)).toBe(300);

    config.logic = {interval_seconds: 120} as typeof config.logic;
    expect(factory.getIntervalSeconds(config)).toBe(120);
  });
});
