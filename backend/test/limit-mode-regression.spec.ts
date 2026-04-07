import { describe, expect, it } from "vitest";

import { EnergyPrice, TariffSlot } from "@chargecaster/domain";

import type { PriceSlot, SimulationConfig } from "@chargecaster/domain";
import { simulateOptimalSchedule } from "../src/simulation/simulation.service";

describe("limit mode regression", () => {
  it("emits limit while preserving floor headroom ahead of a later negative-price charge window", () => {
    const config: SimulationConfig = {
      battery: {
        capacity_kwh: 10,
        max_charge_power_w: 4000,
        auto_mode_floor_soc: 5,
        max_charge_power_solar_w: 4000,
        max_discharge_power_w: 4000,
        max_charge_soc_percent: 100,
      },
      price: {
        grid_fee_eur_per_kwh: 0,
        feed_in_tariff_eur_per_kwh: 0.08,
      },
      logic: {
        interval_seconds: 300,
        min_hold_minutes: 0,
        allow_battery_export: true,
        optimizer_modes: ["limit", "charge", "auto"],
      },
    };

    const slots: PriceSlot[] = [
      TariffSlot.fromDates(
        new Date("2026-04-06T10:00:00+02:00"),
        new Date("2026-04-06T11:00:00+02:00"),
        EnergyPrice.fromEurPerKwh(0.12),
        "slot-1",
      ),
      TariffSlot.fromDates(
        new Date("2026-04-06T11:00:00+02:00"),
        new Date("2026-04-06T12:00:00+02:00"),
        EnergyPrice.fromEurPerKwh(-0.12),
        "slot-2",
      ),
    ];

    const result = simulateOptimalSchedule(
      config,
      {battery_soc: 5},
      slots,
      {
        solarGenerationKwhPerSlot: [3.2, 0],
        houseLoadWattsPerSlot: [1200, 1200],
      },
    );

    expect(result.oracle_entries[0]?.strategy).toBe("limit");
    expect(result.oracle_entries[0]?.end_soc_percent).toBe(5);
    expect(result.oracle_entries[1]?.strategy).toBe("charge");
    expect(result.oracle_entries[1]?.end_soc_percent).toBeGreaterThan(5);
  });

  it("changes the optimizer search space when config disables the preserve-headroom modes", () => {
    const config: SimulationConfig = {
      battery: {
        capacity_kwh: 10,
        max_charge_power_w: 4000,
        auto_mode_floor_soc: 5,
        max_charge_power_solar_w: 4000,
        max_discharge_power_w: 4000,
        max_charge_soc_percent: 100,
      },
      price: {
        grid_fee_eur_per_kwh: 0,
        feed_in_tariff_eur_per_kwh: 0.08,
      },
      logic: {
        interval_seconds: 300,
        min_hold_minutes: 0,
        allow_battery_export: true,
        optimizer_modes: ["auto", "charge"],
      },
    };

    const slots: PriceSlot[] = [
      TariffSlot.fromDates(
        new Date("2026-04-06T10:00:00+02:00"),
        new Date("2026-04-06T11:00:00+02:00"),
        EnergyPrice.fromEurPerKwh(0.12),
        "slot-1",
      ),
      TariffSlot.fromDates(
        new Date("2026-04-06T11:00:00+02:00"),
        new Date("2026-04-06T12:00:00+02:00"),
        EnergyPrice.fromEurPerKwh(-0.12),
        "slot-2",
      ),
    ];

    const result = simulateOptimalSchedule(
      config,
      {battery_soc: 5},
      slots,
      {
        solarGenerationKwhPerSlot: [3.2, 0],
        houseLoadWattsPerSlot: [1200, 1200],
      },
    );

    expect(result.oracle_entries[0]?.strategy).toBe("auto");
    expect(result.oracle_entries[0]?.end_soc_percent).toBeGreaterThan(5);
  });
});
