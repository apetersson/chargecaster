import { describe, expect, it } from "vitest";

import { EnergyPrice, TariffSlot } from "@chargecaster/domain";

import type { PriceSlot, SimulationConfig } from "@chargecaster/domain";
import { simulateOptimalSchedule } from "../src/simulation/simulation.service";

function createSlotAt(hour: number, price: number): PriceSlot {
  const start = new Date(Date.UTC(2026, 3, 8, hour, 0, 0));
  const end = new Date(Date.UTC(2026, 3, 8, hour + 1, 0, 0));
  return TariffSlot.fromDates(start, end, EnergyPrice.fromEurPerKwh(price), `slot-${hour}`);
}

describe("SNAP grid-fee optimization", () => {
  it("shifts grid charging into the cheaper SNAP slot when the slot-specific grid fee drops", () => {
    const config: SimulationConfig = {
      battery: {
        capacity_kwh: 10,
        max_charge_power_w: 2000,
        auto_mode_floor_soc: 5,
        max_charge_power_solar_w: 2000,
        max_discharge_power_w: 2000,
        max_charge_soc_percent: 100,
      },
      price: {
        grid_fee_eur_per_kwh: 0.2,
        feed_in_tariff_eur_per_kwh: 0,
      },
      logic: {
        interval_seconds: 300,
        min_hold_minutes: 0,
        allow_battery_export: false,
      },
    };
    const slots: PriceSlot[] = [
      createSlotAt(8, 0.25),
      createSlotAt(9, 0.25),
      createSlotAt(10, 0.6),
    ];
    const sharedOptions = {
      solarGenerationKwhPerSlot: [0, 0, 0],
      houseLoadWattsPerSlot: [1500, 1500, 1500],
    };

    const withoutSnap = simulateOptimalSchedule(
      config,
      {battery_soc: 80},
      slots,
      {
        ...sharedOptions,
        gridFeeEurPerKwhBySlot: [0.2, 0.2, 0.2],
      },
    );
    const withSnap = simulateOptimalSchedule(
      config,
      {battery_soc: 80},
      slots,
      {
        ...sharedOptions,
        gridFeeEurPerKwhBySlot: [0.2, 0, 0.2],
      },
    );

    expect(withoutSnap.oracle_entries[0]?.strategy).toBe("charge");
    expect(withSnap.oracle_entries[0]?.strategy).toBe("hold");
    expect(withoutSnap.oracle_entries[0]?.end_soc_percent).toBeGreaterThan(withSnap.oracle_entries[0]?.end_soc_percent ?? 0);
    expect((withSnap.oracle_entries[1]?.grid_energy_wh ?? 0)).toBeGreaterThan(withoutSnap.oracle_entries[1]?.grid_energy_wh ?? 0);
    expect(withSnap.projected_cost_eur).toBeLessThan(withoutSnap.projected_cost_eur);
  });
});
