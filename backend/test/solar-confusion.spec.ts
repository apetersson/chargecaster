import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildSolarForecastFromTimeseries } from "../src/simulation/solar";
import { normalizePriceSlots, simulateOptimalSchedule } from "../src/simulation/simulation.service";
import type { SimulationConfig } from "../src/simulation/types";
import { parseEvccState } from "../src/config/schemas";

describe("solar-confusion fixture: project grid power including solar", () => {
  it("prints solar + grid power per slot (W)", () => {
    const fixturePath = join(process.cwd(), "fixtures", "solar-confusion.json");
    const raw: unknown = JSON.parse(readFileSync(fixturePath, "utf-8"));
    const parsed = parseEvccState(raw);

    const slots = normalizePriceSlots(parsed.forecast);
    expect(slots.length).toBeGreaterThan(0);

    const solarForecast = buildSolarForecastFromTimeseries(parsed.solarTimeseries);

    // Align solar forecast to price slots by timestamp (hour buckets)
    const SLOT_MS = 3_600_000;
    const solarMap = new Map<number, number>();
    for (const s of solarForecast) {
      const startMs = new Date(s.start!).getTime();
      const key = Math.floor(startMs / SLOT_MS);
      const e = Math.max(0, Number(s.energy_kwh ?? 0));
      solarMap.set(key, (solarMap.get(key) ?? 0) + e);
    }
    const solarKwhPerSlot = slots.map((slot) => {
      const key = Math.floor(slot.start.getTime() / SLOT_MS);
      return solarMap.get(key) ?? 0;
    });

    const cfg: SimulationConfig = {
      battery: {
        capacity_kwh: 10,
        max_charge_power_w: 500,
        auto_mode_floor_soc: 5,
      },
      price: {
        // Use snapshot price as grid fee if available (fallback to 0.02 EUR/kWh)
        grid_fee_eur_per_kwh: parsed.priceSnapshot ?? 0.11,
        feed_in_tariff_eur_per_kwh: 0.03,
      },
      logic: {
        interval_seconds: 300,
        min_hold_minutes: 0,
        house_load_w: 2200,
        allow_battery_export: true,
      },
      solar: {
        direct_use_ratio: 0.6,
      },
    };

    const result = simulateOptimalSchedule(
      cfg,
      {battery_soc: parsed.batterySoc ?? 40},
      slots,
      {
        solarGenerationKwhPerSlot: solarKwhPerSlot,
        pvDirectUseRatio: 0.6,
        feedInTariffEurPerKwh: 0.03,
        allowBatteryExport: true,
      },
    );

    expect(result.oracle_entries.length).toBe(slots.length);

    const entries = result.oracle_entries.map((entry, idx) => {
      const slot = slots[idx];
      const duration = slot.durationHours || 1;
      const gridEnergyWh = entry.grid_energy_wh ?? 0;
      const gridPowerW = gridEnergyWh / duration;
      const solarEnergyKwh = solarKwhPerSlot[idx] ?? 0;
      const solarPowerW = (solarEnergyKwh / duration) * 1000;
      const priceEurPerKwh = slot.price;
      const priceWithFeeEurPerKwh = priceEurPerKwh + (cfg.price.grid_fee_eur_per_kwh ?? 0);
      return {
        era_id: entry.era_id,
        start: slot.start.toISOString(),
        end: slot.end.toISOString(),
        grid_energy_wh: Math.round(gridEnergyWh * 1000) / 1000,
        grid_power_w: Math.round(gridPowerW * 1000) / 1000,
        solar_power_w: Math.round(solarPowerW * 1000) / 1000,
        price_ct_per_kwh: Math.round(priceEurPerKwh * 100 * 1000) / 1000,
        price_with_fee_ct_per_kwh: Math.round(priceWithFeeEurPerKwh * 100 * 1000) / 1000,
        strategy: entry.strategy,
      };
    });

    // Print a compact table for manual inspection in test output
    // eslint-disable-next-line no-console
    console.table(entries.map((e) => ({
      start: e.start,
      price_ct_per_kwh: e.price_ct_per_kwh,
      price_with_fee_ct_per_kwh: e.price_with_fee_ct_per_kwh,
      solar_power_w: e.solar_power_w,
      grid_power_w: e.grid_power_w,
      strategy: e.strategy,
    })));

    // Sanity check: grid power should not spike to implausible 12kW+ imports for this solar profile
    const maxAbsGridPower = Math.max(...entries.map((e) => Math.abs(e.grid_power_w)));
    expect(maxAbsGridPower).toBeLessThan(12_000);
  });
});
