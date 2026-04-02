import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EnergyPrice, TariffSlot } from "@chargecaster/domain";
import type { OracleEntry, PriceSlot, SimulationConfig } from "@chargecaster/domain";
import { simulateOptimalSchedule } from "../src/simulation/simulation.service";

interface LivePlanningVariantFixture {
  captured_at: string;
  description: string;
  live_state: {
    battery_soc: number;
  };
  config: SimulationConfig;
  slots: {
    start: string;
    end: string;
    era_id: string;
    price_eur_per_kwh: number;
    solar_generation_kwh: number;
    house_load_watts: number;
    feed_in_tariff_eur_per_kwh_sunny: number;
    feed_in_tariff_eur_per_kwh_sunny_spot: number;
  }[];
}

function loadFixture(): LivePlanningVariantFixture {
  const fixturePath = join(process.cwd(), "test", "fixtures", "live-planning-variant-regression.json");
  return JSON.parse(readFileSync(fixturePath, "utf-8")) as LivePlanningVariantFixture;
}

function buildSlots(fixture: LivePlanningVariantFixture): PriceSlot[] {
  return fixture.slots.map((slot) =>
    TariffSlot.fromDates(
      new Date(slot.start),
      new Date(slot.end),
      EnergyPrice.fromEurPerKwh(slot.price_eur_per_kwh),
      slot.era_id,
    )
  );
}

function runVariant(fixture: LivePlanningVariantFixture, key: "sunny" | "sunny_spot") {
  return simulateOptimalSchedule(fixture.config, fixture.live_state, buildSlots(fixture), {
    solarGenerationKwhPerSlot: fixture.slots.map((slot) => slot.solar_generation_kwh),
    houseLoadWattsPerSlot: fixture.slots.map((slot) => slot.house_load_watts),
    feedInTariffEurPerKwhBySlot: fixture.slots.map((slot) =>
      key === "sunny" ? slot.feed_in_tariff_eur_per_kwh_sunny : slot.feed_in_tariff_eur_per_kwh_sunny_spot
    ),
    allowBatteryExport: fixture.config.logic.allow_battery_export ?? true,
  });
}

function mapOracleByEra(entries: OracleEntry[]): Map<string, OracleEntry> {
  return new Map(entries.map((entry) => [entry.era_id, entry]));
}

function maxOracleSocDelta(left: OracleEntry[], right: OracleEntry[]): number {
  const rightByEra = mapOracleByEra(right);
  let maxDelta = 0;
  for (const leftEntry of left) {
    const rightEntry = rightByEra.get(leftEntry.era_id);
    if (!rightEntry) {
      continue;
    }
    const leftSoc = leftEntry.end_soc_percent;
    const rightSoc = rightEntry.end_soc_percent;
    if (typeof leftSoc !== "number" || typeof rightSoc !== "number") {
      continue;
    }
    maxDelta = Math.max(maxDelta, Math.abs(leftSoc - rightSoc));
  }
  return maxDelta;
}

function countStrategyDifferences(left: OracleEntry[], right: OracleEntry[]): number {
  const rightByEra = mapOracleByEra(right);
  let differences = 0;
  for (const leftEntry of left) {
    const rightEntry = rightByEra.get(leftEntry.era_id);
    if (!rightEntry) {
      continue;
    }
    if (leftEntry.strategy !== rightEntry.strategy) {
      differences += 1;
    }
  }
  return differences;
}

describe("feed-in variant regression", () => {
  it("keeps more headroom under sunny-spot during the expensive export morning hours", () => {
    const fixture = loadFixture();
    const sunny = runVariant(fixture, "sunny");
    const sunnySpot = runVariant(fixture, "sunny_spot");
    const sunnyByEra = mapOracleByEra(sunny.oracle_entries);
    const sunnySpotByEra = mapOracleByEra(sunnySpot.oracle_entries);

    const sunny08 = sunnyByEra.get("2026-04-03T08:00:00.000Z");
    const spot08 = sunnySpotByEra.get("2026-04-03T08:00:00.000Z");
    const sunny09 = sunnyByEra.get("2026-04-03T09:00:00.000Z");
    const spot09 = sunnySpotByEra.get("2026-04-03T09:00:00.000Z");

    expect(sunny08?.strategy).toBe("auto");
    expect(spot08?.strategy).toBe("hold");
    expect(sunny09?.strategy).toBe("auto");
    expect(spot09?.strategy).toBe("hold");
    expect(sunny08?.end_soc_percent).toBeGreaterThan(spot08?.end_soc_percent ?? 0);
    expect(sunny09?.end_soc_percent).toBeGreaterThan(spot09?.end_soc_percent ?? 0);
  });

  it("shifts more charging into the later low-value window for sunny-spot", () => {
    const fixture = loadFixture();
    const sunny = runVariant(fixture, "sunny");
    const sunnySpot = runVariant(fixture, "sunny_spot");
    const sunnyByEra = mapOracleByEra(sunny.oracle_entries);
    const sunnySpotByEra = mapOracleByEra(sunnySpot.oracle_entries);

    const sunny11 = sunnyByEra.get("2026-04-03T11:00:00.000Z");
    const spot11 = sunnySpotByEra.get("2026-04-03T11:00:00.000Z");
    const sunny12 = sunnyByEra.get("2026-04-03T12:00:00.000Z");
    const spot12 = sunnySpotByEra.get("2026-04-03T12:00:00.000Z");

    expect(spot11?.end_soc_percent).toBeGreaterThan(sunny11?.end_soc_percent ?? 0);
    expect(spot12?.end_soc_percent).toBeGreaterThan(sunny12?.end_soc_percent ?? 0);
    expect(sunny.expected_feed_in_kwh).toBeGreaterThan(0);
    expect(sunnySpot.expected_feed_in_kwh).toBeGreaterThan(0);
  });

  it("does not collapse the two live variants back into the same oracle curve", () => {
    const fixture = loadFixture();
    const sunny = runVariant(fixture, "sunny");
    const sunnySpot = runVariant(fixture, "sunny_spot");

    expect(maxOracleSocDelta(sunny.oracle_entries, sunnySpot.oracle_entries)).toBeGreaterThan(15);
    expect(countStrategyDifferences(sunny.oracle_entries, sunnySpot.oracle_entries)).toBeGreaterThanOrEqual(4);
  });
});
