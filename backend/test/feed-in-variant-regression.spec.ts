import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Percentage } from "@chargecaster/domain";
import type {
  DemandForecastEntry,
  HistoryPoint,
  OracleEntry,
  RawForecastEntry,
  RawSolarEntry,
  SimulationConfig,
  SnapshotPayload,
} from "@chargecaster/domain";
import { SimulationService } from "../src/simulation/simulation.service";

interface FeedInVariantRegressionFixture {
  captured_at: string;
  timezone: string;
  common_inputs: {
    live_state: {
      battery_soc: number;
    };
    price_snapshot_eur_per_kwh: number | null;
    forecast: RawForecastEntry[];
    solar_forecast: RawSolarEntry[];
    demand_forecast: DemandForecastEntry[];
  };
  battery_efficiency: {
    charge_efficiency_percent: number;
    discharge_efficiency_percent: number;
    charge_average_c_rate: number;
    discharge_average_c_rate: number;
  };
  variants: {
    sunny: {
      config: SimulationConfig;
      feed_in_tariff_eur_per_kwh_by_slot: (number | undefined)[];
      observed_result: {
        expected_feed_in_kwh: number;
        oracle_entries: OracleEntry[];
      };
    };
    sunny_spot: {
      config: SimulationConfig;
      feed_in_tariff_eur_per_kwh_by_slot: (number | undefined)[];
      observed_result: {
        expected_feed_in_kwh: number;
        oracle_entries: OracleEntry[];
      };
    };
  };
}

function loadFixture(): FeedInVariantRegressionFixture {
  const fixturePath = join(process.cwd(), "test", "fixtures", "feed-in-variant-regression.json");
  return JSON.parse(readFileSync(fixturePath, "utf-8")) as FeedInVariantRegressionFixture;
}

function createSimulationService(fixture: FeedInVariantRegressionFixture): SimulationService {
  const history: HistoryPoint[] = [];
  const storage = {
    replaceSnapshot: (_payload: SnapshotPayload) => undefined,
    appendHistory: (entries: HistoryPoint[]) => {
      history.push(...entries);
    },
    listHistory: () => history.map((payload, index) => ({
      id: index + 1,
      timestamp: payload.timestamp,
      payload,
    })),
  } as never;
  const batteryEfficiency = {
    estimateRecentEfficiencies: () => ({
      chargeEfficiency: Percentage.fromPercent(fixture.battery_efficiency.charge_efficiency_percent),
      dischargeEfficiency: Percentage.fromPercent(fixture.battery_efficiency.discharge_efficiency_percent),
      chargeAverageCRate: fixture.battery_efficiency.charge_average_c_rate,
      dischargeAverageCRate: fixture.battery_efficiency.discharge_average_c_rate,
      chargeRuns: 0,
      dischargeRuns: 0,
      source: "fallback" as const,
    }),
  } as never;

  return new SimulationService(storage, batteryEfficiency);
}

function runVariant(
  service: SimulationService,
  fixture: FeedInVariantRegressionFixture,
  key: keyof FeedInVariantRegressionFixture["variants"],
) {
  const variant = fixture.variants[key];
  return service.runSimulation({
    config: variant.config,
    liveState: fixture.common_inputs.live_state,
    forecast: fixture.common_inputs.forecast,
    feedInTariffEurPerKwhBySlot: variant.feed_in_tariff_eur_per_kwh_by_slot,
    priceSnapshotEurPerKwh: fixture.common_inputs.price_snapshot_eur_per_kwh,
    solarForecast: fixture.common_inputs.solar_forecast,
    demandForecast: fixture.common_inputs.demand_forecast,
  });
}

function maxOracleSocDelta(left: OracleEntry[], right: OracleEntry[]): number {
  const rightByEra = new Map(right.map((entry) => [entry.era_id, entry]));
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
  const rightByEra = new Map(right.map((entry) => [entry.era_id, entry]));
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
  // Findings from the captured live case:
  // - Both awattar-sunny and awattar-sunny-spot predict negligible export (< 1 kWh).
  // - Their old divergence was not caused by organic DP trade-offs from feed-in prices.
  // - It came from special-case LIMIT/headroom preservation logic that rewrote most of the horizon.
  // This regression keeps the optimiser honest: when export stays negligible, changing only the
  // feed-in tariff source must not radically reshape SoC or strategy curves.
  it("captures a live case where both variants predict negligible export", () => {
    const fixture = loadFixture();
    const service = createSimulationService(fixture);
    const sunny = runVariant(service, fixture, "sunny");
    const sunnySpot = runVariant(service, fixture, "sunny_spot");

    expect(sunny.expected_feed_in_kwh).toBeLessThan(1);
    expect(sunnySpot.expected_feed_in_kwh).toBeLessThan(1);
  });

  it("keeps SoC trajectories near-identical when feed-in stays negligible", () => {
    const fixture = loadFixture();
    const service = createSimulationService(fixture);
    const sunny = runVariant(service, fixture, "sunny");
    const sunnySpot = runVariant(service, fixture, "sunny_spot");

    const maxDelta = maxOracleSocDelta(sunny.oracle_entries, sunnySpot.oracle_entries);

    expect(maxDelta).toBeLessThan(10);
  });

  it("does not rewrite most of the horizon into a different strategy when export stays negligible", () => {
    const fixture = loadFixture();
    const service = createSimulationService(fixture);
    const sunny = runVariant(service, fixture, "sunny");
    const sunnySpot = runVariant(service, fixture, "sunny_spot");

    const differingStrategies = countStrategyDifferences(sunny.oracle_entries, sunnySpot.oracle_entries);

    expect(differingStrategies).toBeLessThan(8);
  });
});
