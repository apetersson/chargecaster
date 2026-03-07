import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { HistoryPoint, SimulationConfig, SnapshotPayload } from "@chargecaster/domain";
import { BacktestService } from "../src/simulation/backtest.service";
import { StorageService, type HistoryRecord } from "../src/storage/storage.service";

function createHistoryPoint(timestamp: string, batterySocPercent = 50): HistoryPoint {
  return {
    timestamp,
    battery_soc_percent: batterySocPercent,
    price_eur_per_kwh: 0.2,
    grid_power_w: 1200,
    solar_power_w: 0,
    solar_energy_wh: 0,
    home_power_w: 1200,
    ev_charge_power_w: null,
    site_demand_power_w: null,
  };
}

function createDay(date: string, untilHour = 24): HistoryPoint[] {
  const points: HistoryPoint[] = [];
  const steps = untilHour * 12;

  for (let step = 0; step < steps; step += 1) {
    const hour = Math.floor(step / 12);
    const minute = (step % 12) * 5;
    const timestamp = new Date(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`);
    points.push(createHistoryPoint(timestamp.toISOString()));
  }

  return points;
}

function toHistoryRecords(points: HistoryPoint[]): HistoryRecord[] {
  return points.map((payload, index) => ({
    id: index + 1,
    timestamp: payload.timestamp,
    payload,
  }));
}

const snapshot: SnapshotPayload = {
  timestamp: "2026-03-07T01:00:00.000Z",
  interval_seconds: 300,
  house_load_w: 1200,
  solar_direct_use_ratio: 0,
  current_soc_percent: 50,
  next_step_soc_percent: 50,
  recommended_soc_percent: 50,
  recommended_final_soc_percent: 50,
  current_mode: "auto",
  price_snapshot_eur_per_kwh: 0.2,
  projected_cost_eur: 0,
  baseline_cost_eur: 0,
  basic_battery_cost_eur: 0,
  active_control_savings_eur: 0,
  projected_savings_eur: 0,
  projected_grid_power_w: 0,
  forecast_hours: 0,
  forecast_samples: 0,
  forecast_eras: [],
  oracle_entries: [],
  history: [],
  warnings: [],
  errors: [],
};

const config: SimulationConfig = {
  battery: {
    capacity_kwh: 10,
    max_charge_power_w: 5000,
    auto_mode_floor_soc: 5,
    max_charge_power_solar_w: 5000,
    max_discharge_power_w: 5000,
    max_charge_soc_percent: 100,
  },
  price: {
    grid_fee_eur_per_kwh: 0.05,
    feed_in_tariff_eur_per_kwh: 0.03,
  },
  logic: {
    interval_seconds: 300,
    min_hold_minutes: 0,
    house_load_w: 1200,
    allow_battery_export: false,
  },
  solar: {
    direct_use_ratio: 0,
  },
};

describe("BacktestService daily history", () => {
  it("skips partial UTC days near the history boundary", () => {
    const fullDay = createDay("2026-03-05");
    const partialDay = createDay("2026-03-06", 13);
    const storage = {
      listAllHistoryAsc: () => toHistoryRecords([...fullDay, ...partialDay]),
    } as Pick<StorageService, "listAllHistoryAsc"> as StorageService;

    const service = new BacktestService(storage);
    const page = service.runDailyHistory(snapshot, config, 7, 0);

    expect(page.hasMore).toBe(false);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.date).toBe("2026-03-05");
  });
});

describe("BacktestService inferred site demand", () => {
  it("reconstructs hidden load from grid, solar, and SOC delta when total demand is missing", () => {
    const end = new Date();
    end.setUTCMinutes(0, 0, 0);
    end.setUTCHours(end.getUTCHours() - 1);
    const start = new Date(end.getTime() - 60 * 60 * 1000);
    const history: HistoryPoint[] = [
      {
        timestamp: start.toISOString(),
        battery_soc_percent: 20,
        price_eur_per_kwh: 0.2,
        grid_power_w: 3000,
        solar_power_w: 5000,
        solar_energy_wh: 5000,
        home_power_w: 4000,
        ev_charge_power_w: null,
        site_demand_power_w: null,
      },
      {
        timestamp: end.toISOString(),
        battery_soc_percent: 10,
        price_eur_per_kwh: 0.2,
        grid_power_w: 0,
        solar_power_w: 0,
        solar_energy_wh: 0,
        home_power_w: 0,
        ev_charge_power_w: null,
        site_demand_power_w: null,
      },
    ];
    const storage = {
      listHistory: () => toHistoryRecords(history),
    } as Pick<StorageService, "listHistory"> as StorageService;

    const service = new BacktestService(storage);
    const result = service.run(snapshot, config);

    expect(result.history_points_used).toBe(2);
    expect(result.actual_total_cost_eur).toBeCloseTo(0.75, 6);
    expect(result.simulated_total_cost_eur).toBeCloseTo(0.625, 6);
    expect(result.intervals[0]?.site_demand_power_w).toBeCloseTo(9000, 6);
    expect(result.intervals[0]?.synthetic_hidden_load_w).toBeCloseTo(5000, 6);
    expect(result.intervals[0]?.simulated_grid_power_w).toBeCloseTo(2500, 6);
  });
});

describe("StorageService listAllHistoryAsc", () => {
  it("returns every stored history row by default", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "chargecaster-storage-"));
    const dbPath = join(tempDir, "backend.sqlite");
    const previousStoragePath = process.env.CHARGECASTER_STORAGE_PATH;
    process.env.CHARGECASTER_STORAGE_PATH = dbPath;

    const service = new StorageService();

    try {
      const history = Array.from({ length: 15_005 }, (_, index) => {
        const timestamp = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
        return createHistoryPoint(timestamp);
      });

      service.appendHistory(history);

      const stored = service.listAllHistoryAsc();
      expect(stored).toHaveLength(history.length);
      expect(stored[0]?.timestamp).toBe(history[0]?.timestamp);
      expect(stored.at(-1)?.timestamp).toBe(history.at(-1)?.timestamp);
    } finally {
      service.onModuleDestroy();
      if (previousStoragePath == null) {
        delete process.env.CHARGECASTER_STORAGE_PATH;
      } else {
        process.env.CHARGECASTER_STORAGE_PATH = previousStoragePath;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
