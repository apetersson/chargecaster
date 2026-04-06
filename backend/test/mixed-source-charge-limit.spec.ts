import { describe, expect, it } from "vitest";

import { EnergyPrice, Percentage, TariffSlot } from "@chargecaster/domain";

import type { PriceSlot, SimulationConfig } from "@chargecaster/domain";
import { simulateOptimalSchedule } from "../src/simulation/optimal-schedule";

describe("mixed-source charge limits", () => {
  it("caps total battery charging at the grid-backed battery limit when grid charging supplements PV surplus", () => {
    const config: SimulationConfig = {
      battery: {
        capacity_kwh: 10,
        chemistry: "lifepo4",
        max_charge_power_w: 4000,
        max_charge_power_solar_w: 4500,
        max_discharge_power_w: 4000,
        auto_mode_floor_soc: 5,
        max_charge_soc_percent: 96,
      },
      price: {
        grid_fee_eur_per_kwh: 0,
        feed_in_tariff_eur_per_kwh: 0.03368,
      },
      logic: {
        interval_seconds: 300,
        min_hold_minutes: 0,
        allow_battery_export: false,
      },
    };

    const slots: PriceSlot[] = [
      TariffSlot.fromDates(
        new Date("2026-04-06T12:00:00.000Z"),
        new Date("2026-04-06T13:00:00.000Z"),
        EnergyPrice.fromEurPerKwh(-0.1156),
        "negative-price-slot",
      ),
      TariffSlot.fromDates(
        new Date("2026-04-06T13:00:00.000Z"),
        new Date("2026-04-06T14:00:00.000Z"),
        EnergyPrice.fromEurPerKwh(0.45),
        "expensive-follow-up-slot",
      ),
    ];

    const result = simulateOptimalSchedule(
      config,
      {battery_soc: 40},
      slots,
      {
        solarGenerationKwhPerSlot: [3.855055, 0],
        houseLoadWattsPerSlot: [1452.136, 3000],
        chargeEfficiency: Percentage.full(),
        dischargeEfficiency: Percentage.full(),
      },
    );

    const maxAllowedGridChargeWh = 4000 - (3855.055 - 1452.136);

    expect(result.oracle_entries[0]?.strategy).toBe("charge");
    expect(result.oracle_entries[0]?.grid_energy_wh ?? 0).toBeLessThanOrEqual(maxAllowedGridChargeWh + 1e-6);
    expect(result.oracle_entries[0]?.grid_energy_wh ?? 0).toBeGreaterThan(0);
    expect(result.oracle_entries[0]?.end_soc_percent ?? 0).toBeGreaterThan(40);
    expect(result.oracle_entries[0]?.end_soc_percent ?? 100).toBeLessThanOrEqual(80);
  });
});
