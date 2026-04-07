import { describe, expect, it } from "vitest";

import { EnergyPrice, TariffSlot } from "@chargecaster/domain";
import type { PriceSlot, SimulationConfig } from "@chargecaster/domain";
import { simulateOptimalSchedule } from "../src/simulation/simulation.service";

describe("awattar-sunny solar charging regression", () => {
  it("keeps the midday solar window in auto/charge for the current live awattar-sunny conditions", () => {
    const config: SimulationConfig = {
      battery: {
        capacity_kwh: 10,
        max_charge_power_w: 4000,
        max_charge_power_solar_w: 4500,
        max_discharge_power_w: 4000,
        auto_mode_floor_soc: 5,
        max_charge_soc_percent: 96,
      },
      price: {
        grid_fee_eur_per_kwh: 0.094224,
        feed_in_tariff_eur_per_kwh: 0.03368,
      },
      logic: {
        interval_seconds: 300,
        min_hold_minutes: 0,
        allow_battery_export: false,
        optimizer_modes: ["auto", "hold", "limit", "charge"],
      },
    };

    const starts = [
      "2026-04-08T08:00:00.000Z",
      "2026-04-08T09:00:00.000Z",
      "2026-04-08T10:00:00.000Z",
      "2026-04-08T11:00:00.000Z",
      "2026-04-08T12:00:00.000Z",
      "2026-04-08T13:00:00.000Z",
      "2026-04-08T14:00:00.000Z",
      "2026-04-08T15:00:00.000Z",
      "2026-04-08T16:00:00.000Z",
      "2026-04-08T17:00:00.000Z",
      "2026-04-08T18:00:00.000Z",
      "2026-04-08T19:00:00.000Z",
      "2026-04-08T20:00:00.000Z",
      "2026-04-08T21:00:00.000Z",
    ];
    const priceEurPerKwh = [
      0.046619999999999995,
      -0.00005,
      -0.01105,
      -0.01957,
      -0.01801,
      -0.00608,
      0.01151,
      0.09245,
      0.13949,
      0.1526,
      0.15178,
      0.13874,
      0.12993,
      0.11987,
    ];
    const solarGenerationKwhPerSlot = [
      4.543899,
      5.561163,
      6.372362,
      6.111606,
      5.72128,
      4.80448,
      3.478465,
      2.203933,
      1.22727,
      0.601651,
      0.1584,
      0,
      0,
      0,
    ];
    const houseLoadWattsPerSlot = [
      2026.636,
      2341.324,
      1454.86,
      1604.064,
      1601.478,
      1231.365,
      1366.245,
      1683.641,
      2018.034,
      2195.928,
      2612.628,
      2217.43,
      2186.269,
      1720.945,
    ];

    const slots: PriceSlot[] = starts.map((start, index) =>
      TariffSlot.fromDates(
        new Date(start),
        new Date(new Date(start).getTime() + 3_600_000),
        EnergyPrice.fromEurPerKwh(priceEurPerKwh[index] ?? 0),
        `slot-${index + 1}`,
      )
    );

    const result = simulateOptimalSchedule(
      config,
      {battery_soc: 19.9},
      slots,
      {
        solarGenerationKwhPerSlot,
        houseLoadWattsPerSlot,
        feedInTariffEurPerKwh: 0.03368,
        allowBatteryExport: false,
      },
    );

    const byEra = new Map(result.oracle_entries.map((entry) => [entry.era_id, entry]));
    const tenToEleven = byEra.get("slot-3");
    const elevenToTwelve = byEra.get("slot-4");

    expect(["auto", "charge"]).toContain(tenToEleven?.strategy);
    expect(["auto", "charge"]).toContain(elevenToTwelve?.strategy);
    expect((tenToEleven?.end_soc_percent ?? 0) > 19.9 || (elevenToTwelve?.end_soc_percent ?? 0) > 19.9).toBe(true);
  });
});
