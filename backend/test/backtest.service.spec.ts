import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { HistoryPoint, SimulationConfig, SnapshotPayload } from "@chargecaster/domain";
import { BacktestService } from "../src/simulation/backtest.service";
import { ContinuousBacktestStrategy } from "../src/simulation/continuous-backtest.strategy";
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

afterEach(() => {
  vi.useRealTimers();
});

function createService(storage: StorageService): BacktestService {
  return new BacktestService(storage, new ContinuousBacktestStrategy(storage));
}

describe("BacktestService daily history", () => {
  it("skips partial UTC days near the history boundary", () => {
    const fullDay = createDay("2026-03-05");
    const partialDay = createDay("2026-03-06", 13);
    const storage = {
      listHistoryDayStatsBefore: () => [
        {
          date: "2026-03-06",
          firstTimestamp: "2026-03-06T00:00:00.000Z",
          lastTimestamp: "2026-03-06T12:55:00.000Z",
          pointCount: partialDay.length,
        },
        {
          date: "2026-03-05",
          firstTimestamp: "2026-03-05T00:00:00.000Z",
          lastTimestamp: "2026-03-05T23:55:00.000Z",
          pointCount: fullDay.length,
        },
      ],
      listHistoryRangeAsc: (startInclusive: string, endExclusive: string) =>
        toHistoryRecords(fullDay.filter((point) => point.timestamp >= startInclusive && point.timestamp < endExclusive)),
      listDailyBacktestSummaries: () => [],
      upsertDailyBacktestSummaries: () => undefined,
    } as unknown as StorageService;

    const service = createService(storage);
    const page = service.runDailyHistory(snapshot, config, 7, 0);

    expect(page.hasMore).toBe(false);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]?.date).toBe("2026-03-05");
  });

  it("uses cached summaries for older days while keeping yesterday live", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"));

    const cachedSummary = {
      generated_at: "2026-03-08T00:00:00.000Z",
      actual_total_cost_eur: 12,
      simulated_total_cost_eur: 10,
      simulated_start_soc_percent: 50,
      actual_final_soc_percent: 50,
      simulated_final_soc_percent: 40,
      soc_value_adjustment_eur: 0.5,
      adjusted_actual_cost_eur: 11.5,
      adjusted_simulated_cost_eur: 10,
      savings_eur: -1.5,
      avg_price_eur_per_kwh: 0.25,
      history_points_used: 288,
      span_hours: 23.9,
    };
    const listDailyBacktestSummaries = vi.fn().mockReturnValue([
      {
        date: "2026-03-06",
        configFingerprint: "cached",
        updatedAt: "2026-03-08T00:01:00.000Z",
        payload: cachedSummary,
        strategy: "continuous",
        simulatedStartSocPercent: 50,
        simulatedFinalSocPercent: 40,
      },
    ]);
    const upsertDailyBacktestSummaries = vi.fn();
    const listHistoryRangeAsc = vi.fn((startInclusive: string, endExclusive: string) => {
      const points = [...createDay("2026-03-05"), ...createDay("2026-03-06"), ...createDay("2026-03-07")]
        .filter((point) => point.timestamp >= startInclusive && point.timestamp < endExclusive);
      return toHistoryRecords(points);
    });
    const listHistoryDayStatsBefore = vi.fn(() => [
      {
        date: "2026-03-07",
        firstTimestamp: "2026-03-07T00:00:00.000Z",
        lastTimestamp: "2026-03-07T23:55:00.000Z",
        pointCount: 288,
      },
      {
        date: "2026-03-06",
        firstTimestamp: "2026-03-06T00:00:00.000Z",
        lastTimestamp: "2026-03-06T23:55:00.000Z",
        pointCount: 288,
      },
      {
        date: "2026-03-05",
        firstTimestamp: "2026-03-05T00:00:00.000Z",
        lastTimestamp: "2026-03-05T23:55:00.000Z",
        pointCount: 288,
      },
    ]);
    const storage = {
      listHistoryDayStatsBefore,
      listHistoryRangeAsc,
      listDailyBacktestSummaries,
      upsertDailyBacktestSummaries,
    } as unknown as StorageService;

    const service = createService(storage);
    const page = service.runDailyHistory(snapshot, config, 2, 0);

    expect(page.entries.map((entry) => entry.date)).toEqual(["2026-03-07", "2026-03-06"]);
    expect(page.entries[0]?.result.intervals.length).toBeGreaterThan(0);
    expect(page.entries[1]?.result.intervals).toHaveLength(0);
    expect(page.entries[1]?.result.actual_total_cost_eur).toBe(12);
    expect(listHistoryDayStatsBefore).toHaveBeenCalledTimes(1);
    expect(listHistoryRangeAsc).toHaveBeenCalledTimes(2);
    expect(listHistoryRangeAsc).toHaveBeenNthCalledWith(1, "2026-03-07T00:00:00.000Z", "2026-03-08T00:00:00.000Z");
    expect(listHistoryRangeAsc).toHaveBeenNthCalledWith(2, "2026-03-08T00:00:00.000Z", "2026-03-09T00:00:00.000Z");
    expect(listDailyBacktestSummaries).toHaveBeenCalledTimes(1);
    expect(upsertDailyBacktestSummaries).not.toHaveBeenCalled();
  });

  it("recomputes interval detail for a cached day when a detail view is requested", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T12:00:00.000Z"));

    const cachedSummary = {
      generated_at: "2026-03-08T00:00:00.000Z",
      actual_total_cost_eur: 12,
      simulated_total_cost_eur: 10,
      simulated_start_soc_percent: 50,
      actual_final_soc_percent: 50,
      simulated_final_soc_percent: 40,
      soc_value_adjustment_eur: 0.5,
      adjusted_actual_cost_eur: 11.5,
      adjusted_simulated_cost_eur: 10,
      savings_eur: -1.5,
      avg_price_eur_per_kwh: 0.25,
      history_points_used: 288,
      span_hours: 23.9,
    };
    const listDailyBacktestSummaries = vi.fn()
      .mockReturnValueOnce([])
      .mockReturnValueOnce([
        {
          date: "2026-03-06",
          configFingerprint: "cached",
          updatedAt: "2026-03-08T00:01:00.000Z",
          payload: cachedSummary,
          strategy: "continuous",
          simulatedStartSocPercent: 50,
          simulatedFinalSocPercent: 40,
        },
      ]);
    const upsertDailyBacktestSummaries = vi.fn();
    const listHistoryRangeAsc = vi.fn((startInclusive: string, endExclusive: string) => {
      const points = [...createDay("2026-03-05"), ...createDay("2026-03-06"), ...createDay("2026-03-07")]
        .filter((point) => point.timestamp >= startInclusive && point.timestamp < endExclusive);
      return toHistoryRecords(points);
    });
    const storage = {
      listHistoryDayStatsBefore: () => [
        {
          date: "2026-03-07",
          firstTimestamp: "2026-03-07T00:00:00.000Z",
          lastTimestamp: "2026-03-07T23:55:00.000Z",
          pointCount: 288,
        },
        {
          date: "2026-03-06",
          firstTimestamp: "2026-03-06T00:00:00.000Z",
          lastTimestamp: "2026-03-06T23:55:00.000Z",
          pointCount: 288,
        },
        {
          date: "2026-03-05",
          firstTimestamp: "2026-03-05T00:00:00.000Z",
          lastTimestamp: "2026-03-05T23:55:00.000Z",
          pointCount: 288,
        },
      ],
      listHistoryRangeAsc,
      listDailyBacktestSummaries,
      upsertDailyBacktestSummaries,
    } as unknown as StorageService;

    const service = createService(storage);
    const detail = service.getDailyHistoryDetail(snapshot, config, "2026-03-06");

    expect(detail?.date).toBe("2026-03-06");
    expect(detail?.result.intervals.length).toBeGreaterThan(0);
    expect(detail?.result.intervals[0]?.end_timestamp).toBeTruthy();
    expect(detail?.result.intervals[0]?.cumulative_savings_eur).toBeTypeOf("number");
    expect(listHistoryRangeAsc).toHaveBeenCalled();
    expect(upsertDailyBacktestSummaries).toHaveBeenCalledTimes(1);
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

    const service = createService(storage);
    const result = service.run(snapshot, config);

    expect(result.history_points_used).toBe(2);
    expect(result.actual_total_cost_eur).toBeCloseTo(0.75, 6);
    expect(result.simulated_total_cost_eur).toBeCloseTo(0.625, 6);
    expect(result.intervals[0]?.site_demand_power_w).toBeCloseTo(9000, 6);
    expect(result.intervals[0]?.synthetic_hidden_load_w).toBeCloseTo(5000, 6);
    expect(result.intervals[0]?.simulated_soc_start_percent).toBeCloseTo(20, 6);
    expect(result.intervals[0]?.simulated_grid_power_w).toBeCloseTo(2500, 6);
    expect(result.intervals[0]?.cumulative_savings_eur).toBeCloseTo(0, 6);
    expect(result.intervals[0]?.actual_charge_from_grid_w).toBeCloseTo(0, 6);
    expect(result.intervals[0]?.actual_charge_from_solar_w).toBeCloseTo(0, 6);
    expect(result.intervals[0]?.simulated_charge_from_solar_w).toBeCloseTo(0, 6);
  });
});

describe("BacktestService continuous daily carry", () => {
  it("does not treat inherited start-of-day SOC advantage as same-day profit", () => {
    const dayPoints: HistoryPoint[] = [
      {
        timestamp: "2026-03-06T00:00:00.000Z",
        battery_soc_percent: 70,
        price_eur_per_kwh: 0.2,
        grid_power_w: 0,
        solar_power_w: 0,
        solar_energy_wh: 0,
        home_power_w: 0,
        ev_charge_power_w: null,
        site_demand_power_w: null,
      },
      {
        timestamp: "2026-03-06T00:05:00.000Z",
        battery_soc_percent: 70,
        price_eur_per_kwh: 0.2,
        grid_power_w: 0,
        solar_power_w: 0,
        solar_energy_wh: 0,
        home_power_w: 0,
        ev_charge_power_w: null,
        site_demand_power_w: null,
      },
    ];
    const nextDayPoints: HistoryPoint[] = [
      createHistoryPoint("2026-03-07T00:00:00.000Z", 70),
      createHistoryPoint("2026-03-07T00:05:00.000Z", 70),
    ];
    const storage = {
      listHistoryRangeAsc: (startInclusive: string, endExclusive: string) => {
        if (startInclusive === "2026-03-06T00:00:00.000Z" && endExclusive === "2026-03-07T00:00:00.000Z") {
          return toHistoryRecords(dayPoints);
        }
        if (startInclusive === "2026-03-07T00:00:00.000Z" && endExclusive === "2026-03-08T00:00:00.000Z") {
          return toHistoryRecords(nextDayPoints);
        }
        return [];
      },
    } as Pick<StorageService, "listHistoryRangeAsc"> as StorageService;

    const strategy = new ContinuousBacktestStrategy(storage);
    const entry = strategy.buildDailyEntry("2026-03-06", config, {
      initialSimSocPercent: 5,
    });

    expect(entry).not.toBeNull();
    expect(entry?.result.simulated_start_soc_percent).toBe(5);
    expect(entry?.result.soc_value_adjustment_eur).toBeCloseTo(0, 6);
    expect(entry?.result.savings_eur).toBeCloseTo(0, 6);
    expect(entry?.result.intervals[0]?.inventory_value_eur).toBeCloseTo(0, 6);
    expect(entry?.result.intervals[0]?.cumulative_savings_eur).toBeCloseTo(0, 6);
  });

  it("carries simulated SOC across consecutive days instead of resetting at midnight", () => {
    const createLowLoadDay = (date: string) => {
      const points = createDay(date);
      return points.map((point) => ({
        ...point,
        battery_soc_percent: 80,
        solar_power_w: 2400,
        home_power_w: 0,
        grid_power_w: -2400,
      }));
    };
    const createHighLoadDay = (date: string) => {
      const points = createDay(date);
      return points.map((point) => ({
        ...point,
        battery_soc_percent: 80,
        solar_power_w: 0,
        home_power_w: 4200,
        grid_power_w: 4200,
      }));
    };

    const allPoints = [
      ...createLowLoadDay("2026-03-05"),
      ...createHighLoadDay("2026-03-06"),
      ...createDay("2026-03-07"),
    ];
    const storage = {
      listHistoryDayStatsBefore: () => [
        {
          date: "2026-03-07",
          firstTimestamp: "2026-03-07T00:00:00.000Z",
          lastTimestamp: "2026-03-07T23:55:00.000Z",
          pointCount: 288,
        },
        {
          date: "2026-03-06",
          firstTimestamp: "2026-03-06T00:00:00.000Z",
          lastTimestamp: "2026-03-06T23:55:00.000Z",
          pointCount: 288,
        },
        {
          date: "2026-03-05",
          firstTimestamp: "2026-03-05T00:00:00.000Z",
          lastTimestamp: "2026-03-05T23:55:00.000Z",
          pointCount: 288,
        },
      ],
      listHistoryRangeAsc: (startInclusive: string, endExclusive: string) =>
        toHistoryRecords(allPoints.filter((point) => point.timestamp >= startInclusive && point.timestamp < endExclusive)),
      listDailyBacktestSummaries: () => [],
      upsertDailyBacktestSummaries: () => undefined,
    } as unknown as StorageService;

    const service = createService(storage);
    const page = service.runDailyHistory(snapshot, config, 2, 0);
    const latestDay = page.entries.find((entry) => entry.date === "2026-03-06");

    expect(latestDay?.result.intervals[0]?.simulated_soc_percent).toBeGreaterThan(80);
    expect(latestDay?.result.simulated_final_soc_percent).toBe(5);
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

  it("materializes cached daily backtests into a dedicated table", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "chargecaster-storage-"));
    const dbPath = join(tempDir, "backend.sqlite");
    const previousStoragePath = process.env.CHARGECASTER_STORAGE_PATH;
    process.env.CHARGECASTER_STORAGE_PATH = dbPath;

    const storage = new StorageService();
    const service = createService(storage);

    try {
      storage.appendHistory([
        ...createDay("2026-03-05"),
        ...createDay("2026-03-06"),
        ...createDay("2026-03-07"),
      ]);

      const result = service.materializeHistoricalDailyBacktests(config, {today: "2026-03-08"});
      const fingerprint = service.buildCacheFingerprint(config);
      const cached = storage.listDailyBacktestSummaries(fingerprint, ["2026-03-05", "2026-03-06", "2026-03-07"]);

      expect(result.materialized).toBe(2);
      expect(cached.map((entry) => entry.date)).toEqual(["2026-03-06", "2026-03-05"]);
      expect(cached[0]?.strategy).toBe("continuous");
      expect(cached[0]?.simulatedStartSocPercent).toBeGreaterThanOrEqual(0);
      expect(cached[0]?.simulatedFinalSocPercent).toBeGreaterThanOrEqual(0);
    } finally {
      storage.onModuleDestroy();
      if (previousStoragePath == null) {
        delete process.env.CHARGECASTER_STORAGE_PATH;
      } else {
        process.env.CHARGECASTER_STORAGE_PATH = previousStoragePath;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("only backfills missing daily summaries when requested", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "chargecaster-storage-"));
    const dbPath = join(tempDir, "backend.sqlite");
    const previousStoragePath = process.env.CHARGECASTER_STORAGE_PATH;
    process.env.CHARGECASTER_STORAGE_PATH = dbPath;

    const storage = new StorageService();
    const service = createService(storage);

    try {
      storage.appendHistory([
        ...createDay("2026-03-05"),
        ...createDay("2026-03-06"),
        ...createDay("2026-03-07"),
      ]);

      const fingerprint = service.buildCacheFingerprint(config);
      storage.upsertDailyBacktestSummaries([
        {
          date: "2026-03-05",
          configFingerprint: fingerprint,
          payload: {
            generated_at: "2026-03-08T00:00:00.000Z",
            actual_total_cost_eur: 1,
            simulated_total_cost_eur: 1,
            simulated_start_soc_percent: 1,
            actual_final_soc_percent: 1,
            simulated_final_soc_percent: 1,
            soc_value_adjustment_eur: 0,
            adjusted_actual_cost_eur: 1,
            adjusted_simulated_cost_eur: 1,
            savings_eur: 0,
            avg_price_eur_per_kwh: 0.2,
            history_points_used: 288,
            span_hours: 24,
          },
          strategy: "continuous",
          simulatedStartSocPercent: 1,
          simulatedFinalSocPercent: 1,
        },
      ]);

      const result = service.materializeHistoricalDailyBacktests(config, {
        today: "2026-03-08",
        missingOnly: true,
      });
      const cached = storage.listDailyBacktestSummaries(fingerprint, ["2026-03-05", "2026-03-06"]);

      expect(result.materialized).toBe(1);
      expect(cached.map((entry) => entry.date)).toEqual(["2026-03-06", "2026-03-05"]);
      expect(cached.find((entry) => entry.date === "2026-03-05")?.payload.actual_total_cost_eur).toBe(1);
    } finally {
      storage.onModuleDestroy();
      if (previousStoragePath == null) {
        delete process.env.CHARGECASTER_STORAGE_PATH;
      } else {
        process.env.CHARGECASTER_STORAGE_PATH = previousStoragePath;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("clears legacy daily backtest summaries when ledger columns are introduced", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "chargecaster-storage-"));
    const dbPath = join(tempDir, "backend.sqlite");
    const previousStoragePath = process.env.CHARGECASTER_STORAGE_PATH;
    process.env.CHARGECASTER_STORAGE_PATH = dbPath;

    const legacyStorage = new StorageService();

    try {
      const rawDb = (legacyStorage as unknown as { db: { exec: (sql: string) => void } }).db;
      rawDb.exec("DROP TABLE daily_backtest_summaries");
      rawDb.exec(`
        CREATE TABLE daily_backtest_summaries
        (
            date               TEXT NOT NULL,
            config_fingerprint TEXT NOT NULL,
            updated_at         TEXT NOT NULL,
            payload            TEXT NOT NULL,
            PRIMARY KEY (date, config_fingerprint)
        );
      `);
      rawDb.exec(`
        INSERT INTO daily_backtest_summaries (date, config_fingerprint, updated_at, payload)
        VALUES ('2026-03-05', 'legacy', '2026-03-08T00:00:00.000Z', '{"generated_at":"2026-03-08T00:00:00.000Z","actual_total_cost_eur":1,"simulated_total_cost_eur":1,"simulated_start_soc_percent":1,"actual_final_soc_percent":1,"simulated_final_soc_percent":1,"soc_value_adjustment_eur":0,"adjusted_actual_cost_eur":1,"adjusted_simulated_cost_eur":1,"savings_eur":0,"avg_price_eur_per_kwh":0.2,"history_points_used":288,"span_hours":24}')
      `);
    } finally {
      legacyStorage.onModuleDestroy();
    }

    const migratedStorage = new StorageService();

    try {
      const rows = migratedStorage.listDailyBacktestSummaries("legacy", ["2026-03-05"]);
      expect(rows).toHaveLength(0);
    } finally {
      migratedStorage.onModuleDestroy();
      if (previousStoragePath == null) {
        delete process.env.CHARGECASTER_STORAGE_PATH;
      } else {
        process.env.CHARGECASTER_STORAGE_PATH = previousStoragePath;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("clears existing daily backtest summaries exactly once for the relative-SOC migration", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "chargecaster-storage-"));
    const dbPath = join(tempDir, "backend.sqlite");
    const previousStoragePath = process.env.CHARGECASTER_STORAGE_PATH;
    process.env.CHARGECASTER_STORAGE_PATH = dbPath;

    const initialStorage = new StorageService();

    try {
      initialStorage.upsertDailyBacktestSummaries([
        {
          date: "2026-03-05",
          configFingerprint: "continuous",
          strategy: "continuous",
          simulatedStartSocPercent: 5,
          simulatedFinalSocPercent: 5,
          payload: {
            generated_at: "2026-03-08T00:00:00.000Z",
            actual_total_cost_eur: 1,
            simulated_total_cost_eur: 1,
            simulated_start_soc_percent: 5,
            actual_final_soc_percent: 20,
            simulated_final_soc_percent: 5,
            soc_value_adjustment_eur: 1,
            adjusted_actual_cost_eur: 0,
            adjusted_simulated_cost_eur: 1,
            savings_eur: 1,
            avg_price_eur_per_kwh: 0.2,
            history_points_used: 288,
            span_hours: 24,
          },
        },
      ]);
      const rawDb = (initialStorage as unknown as { db: { exec: (sql: string) => void } }).db;
      rawDb.exec(`
        DELETE FROM app_migrations
        WHERE id = '2026-03-07-reset-daily-backtest-summaries-for-relative-soc'
      `);
    } finally {
      initialStorage.onModuleDestroy();
    }

    const migratedStorage = new StorageService();

    try {
      const rows = migratedStorage.listDailyBacktestSummaries("continuous", ["2026-03-05"]);
      expect(rows).toHaveLength(0);
    } finally {
      migratedStorage.onModuleDestroy();
    }

    const reopenedStorage = new StorageService();

    try {
      reopenedStorage.upsertDailyBacktestSummaries([
        {
          date: "2026-03-05",
          configFingerprint: "continuous",
          strategy: "continuous",
          simulatedStartSocPercent: 5,
          simulatedFinalSocPercent: 5,
          payload: {
            generated_at: "2026-03-08T00:00:00.000Z",
            actual_total_cost_eur: 1,
            simulated_total_cost_eur: 1,
            simulated_start_soc_percent: 5,
            actual_final_soc_percent: 20,
            simulated_final_soc_percent: 5,
            soc_value_adjustment_eur: 0,
            adjusted_actual_cost_eur: 1,
            adjusted_simulated_cost_eur: 1,
            savings_eur: 0,
            avg_price_eur_per_kwh: 0.2,
            history_points_used: 288,
            span_hours: 24,
          },
        },
      ]);
    } finally {
      reopenedStorage.onModuleDestroy();
    }

    const finalStorage = new StorageService();

    try {
      const rows = finalStorage.listDailyBacktestSummaries("continuous", ["2026-03-05"]);
      expect(rows).toHaveLength(1);
    } finally {
      finalStorage.onModuleDestroy();
      if (previousStoragePath == null) {
        delete process.env.CHARGECASTER_STORAGE_PATH;
      } else {
        process.env.CHARGECASTER_STORAGE_PATH = previousStoragePath;
      }
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
