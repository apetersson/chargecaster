import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { Percentage } from "@chargecaster/domain";
import type {
  DemandForecastEntry,
  HistoryPoint,
  RawForecastEntry,
  RawSolarEntry,
  SimulationConfig,
  SnapshotPayload,
} from "@chargecaster/domain";
import { SimulationService } from "../src/simulation/simulation.service";

interface LiveMidnightRegressionFixture {
  captured_at: string;
  timezone: string;
  target_midnight_utc: string;
  config: SimulationConfig;
  live_state: {
    battery_soc: number;
  };
  price_snapshot_eur_per_kwh: number | null;
  forecast: RawForecastEntry[];
  feed_in_tariff_eur_per_kwh_by_slot: (number | undefined)[];
  solar_forecast: RawSolarEntry[];
  demand_forecast: DemandForecastEntry[];
  expected: {
    midnight_soc_less_than_percent: number;
    reference_midnight_soc_percent: number | null;
  };
  battery_efficiency: {
    charge_efficiency_percent: number;
    discharge_efficiency_percent: number;
    charge_average_c_rate: number;
    discharge_average_c_rate: number;
  };
}

function loadFixture(): LiveMidnightRegressionFixture {
  const fixturePath = join(process.cwd(), "test", "fixtures", "live-midnight-soc-regression.json");
  return JSON.parse(readFileSync(fixturePath, "utf-8")) as LiveMidnightRegressionFixture;
}

describe("live midnight SoC regression", () => {
  it("keeps the battery below 15% at local midnight for the captured live inputs", () => {
    const fixture = loadFixture();
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

    const service = new SimulationService(storage, batteryEfficiency);
    const result = service.runSimulation({
      config: fixture.config,
      liveState: fixture.live_state,
      forecast: fixture.forecast,
      feedInTariffEurPerKwhBySlot: fixture.feed_in_tariff_eur_per_kwh_by_slot,
      priceSnapshotEurPerKwh: fixture.price_snapshot_eur_per_kwh,
      solarForecast: fixture.solar_forecast,
      demandForecast: fixture.demand_forecast,
    });

    const targetMidnightMs = Date.parse(fixture.target_midnight_utc);
    const midnightEntry = result.oracle_entries.find((entry) => Date.parse(entry.era_id) === targetMidnightMs);

    expect(midnightEntry).toBeDefined();
    expect(midnightEntry?.end_soc_percent).not.toBeNull();
    expect(midnightEntry?.end_soc_percent ?? 100).toBeLessThan(fixture.expected.midnight_soc_less_than_percent);
    expect(midnightEntry?.end_soc_percent).toBe(fixture.expected.reference_midnight_soc_percent);
  });
});
