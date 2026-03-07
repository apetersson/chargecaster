import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SimulationConfig } from "@chargecaster/domain";
import { ConfigFileService } from "../src/config/config-file.service";
import { SimulationConfigFactory } from "../src/config/simulation-config.factory";
import { ContinuousBacktestStrategy } from "../src/simulation/continuous-backtest.strategy";
import { DailyIsolatedBacktestStrategy } from "../src/simulation/daily-isolated-backtest.strategy";
import { StorageService, type HistoryDayStatRecord } from "../src/storage/storage.service";

const describeDb = process.env.RUN_DB_BACKTEST === "1" ? describe : describe.skip;

let storage: StorageService | null = null;

function previousUtcDate(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function nextUtcDate(date: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function isCompleteUtcDayStat(stat: HistoryDayStatRecord): boolean {
  if (stat.pointCount < 2) {
    return false;
  }

  const dayStart = new Date(`${stat.date}T00:00:00Z`).getTime();
  const dayEnd = dayStart + 24 * 3600_000;
  const firstPoint = new Date(stat.firstTimestamp).getTime();
  const lastPoint = new Date(stat.lastTimestamp).getTime();
  const boundaryToleranceMs = 2 * 3600_000;

  return firstPoint - dayStart <= boundaryToleranceMs && dayEnd - lastPoint <= boundaryToleranceMs;
}

function listAvailableDays(storageService: StorageService, today = new Date().toISOString().slice(0, 10)): string[] {
  const yesterday = previousUtcDate(today);
  const stats = storageService.listHistoryDayStatsBefore(today);
  const completeDays = new Set(
    stats
      .filter((stat) => isCompleteUtcDayStat(stat))
      .map((stat) => stat.date),
  );

  return stats
    .map((stat) => stat.date)
    .filter((date) => date < yesterday && completeDays.has(date) && completeDays.has(nextUtcDate(date)));
}

function buildComparison(
  isolated: DailyIsolatedBacktestStrategy,
  continuous: ContinuousBacktestStrategy,
  config: SimulationConfig,
  datesAsc: string[],
): {
  dailyRows: Record<string, number | string>[];
  hourlyRows: Record<string, number | string>[];
  totals: Record<string, number | string>;
} {
  let previousContinuousFinalSoc: number | null = null;
  const dailyRows: Record<string, number | string>[] = [];
  const hourlyRows: Record<string, number | string>[] = [];
  let isolatedSavingsTotal = 0;
  let continuousSavingsTotal = 0;

  for (const date of datesAsc) {
    const isolatedEntry = isolated.buildDailyEntry(date, config);
    const continuousEntry = continuous.buildDailyEntry(date, config, {
      initialSimSocPercent: previousContinuousFinalSoc,
    });
    if (!isolatedEntry || !continuousEntry) {
      continue;
    }
    previousContinuousFinalSoc = continuousEntry.result.simulated_final_soc_percent;
    isolatedSavingsTotal += isolatedEntry.result.savings_eur;
    continuousSavingsTotal += continuousEntry.result.savings_eur;

    dailyRows.push({
      date,
      isolated_savings_eur: Number(isolatedEntry.result.savings_eur.toFixed(2)),
      continuous_savings_eur: Number(continuousEntry.result.savings_eur.toFixed(2)),
      delta_eur: Number((continuousEntry.result.savings_eur - isolatedEntry.result.savings_eur).toFixed(2)),
      isolated_final_soc: Number(isolatedEntry.result.simulated_final_soc_percent.toFixed(1)),
      continuous_final_soc: Number(continuousEntry.result.simulated_final_soc_percent.toFixed(1)),
    });

    const isolatedHourly = new Map(
      isolatedEntry.result.intervals.map((interval) => [interval.timestamp.slice(0, 13), interval]),
    );
    const continuousHourly = new Map(
      continuousEntry.result.intervals.map((interval) => [interval.timestamp.slice(0, 13), interval]),
    );
    for (const hour of Array.from(new Set([...isolatedHourly.keys(), ...continuousHourly.keys()])).sort()) {
      const isolatedInterval = isolatedHourly.get(hour);
      const continuousInterval = continuousHourly.get(hour);
      hourlyRows.push({
        date,
        hour: hour.slice(11, 13),
        actual_soc: Number((continuousInterval?.actual_soc_percent ?? isolatedInterval?.actual_soc_percent ?? 0).toFixed(1)),
        isolated_auto_soc: Number((isolatedInterval?.simulated_soc_percent ?? 0).toFixed(1)),
        continuous_auto_soc: Number((continuousInterval?.simulated_soc_percent ?? 0).toFixed(1)),
      });
    }
  }

  return {
    dailyRows,
    hourlyRows,
    totals: {
      days: dailyRows.length,
      isolated_savings_total_eur: Number(isolatedSavingsTotal.toFixed(2)),
      continuous_savings_total_eur: Number(continuousSavingsTotal.toFixed(2)),
      delta_total_eur: Number((continuousSavingsTotal - isolatedSavingsTotal).toFixed(2)),
    },
  };
}

async function loadDbContext(): Promise<{
  isolated: DailyIsolatedBacktestStrategy;
  continuous: ContinuousBacktestStrategy;
  config: SimulationConfig;
}> {
  const dbPath = resolve(process.cwd(), "..", "data", "db", "backend.sqlite");
  const configFile = new ConfigFileService();
  const configPath = configFile.resolvePath();
  if (!existsSync(dbPath)) {
    throw new Error(`Backtest database not found at ${dbPath}`);
  }
  if (!existsSync(configPath)) {
    throw new Error(`Config file not found at ${configPath}`);
  }

  storage = new StorageService();
  const isolated = new DailyIsolatedBacktestStrategy(storage);
  const continuous = new ContinuousBacktestStrategy(storage);
  const configFactory = new SimulationConfigFactory();
  const document = await configFile.loadDocument(configPath);
  const config = configFactory.create(document);
  return {isolated, continuous, config};
}

describeDb("DailyIsolatedBacktestStrategy database smoke test", () => {
  afterAll(() => {
    storage?.onModuleDestroy();
    storage = null;
  });

  it("prints isolated versus continuous backtests from sqlite", async () => {
    const dbPath = resolve(process.cwd(), "..", "data", "db", "backend.sqlite");
    const configFile = new ConfigFileService();
    const configPath = configFile.resolvePath();
    if (!existsSync(dbPath)) {
      throw new Error(`Backtest database not found at ${dbPath}`);
    }
    if (!existsSync(configPath)) {
      throw new Error(`Config file not found at ${configPath}`);
    }

    const previousStoragePath = process.env.CHARGECASTER_STORAGE_PATH;
    process.env.CHARGECASTER_STORAGE_PATH = dbPath;

    try {
      const {isolated, continuous, config} = await loadDbContext();
      const datesAsc = [...listAvailableDays(storage!).slice(0, 7)].sort();
      const comparison = buildComparison(isolated, continuous, config, datesAsc);

      console.log("\nDaily savings comparison");
      console.table(comparison.dailyRows);
      console.log("\nHourly SOC curves");
      console.table(comparison.hourlyRows);
      console.log("\nTotals");
      console.table([comparison.totals]);
      expect(comparison.dailyRows.length).toBeGreaterThan(0);
    } finally {
      storage?.onModuleDestroy();
      storage = null;
      if (previousStoragePath == null) {
        delete process.env.CHARGECASTER_STORAGE_PATH;
      } else {
        process.env.CHARGECASTER_STORAGE_PATH = previousStoragePath;
      }
    }
  });

  it("prints full-db daily and total savings for both strategies", async () => {
    const previousStoragePath = process.env.CHARGECASTER_STORAGE_PATH;
    process.env.CHARGECASTER_STORAGE_PATH = resolve(process.cwd(), "..", "data", "db", "backend.sqlite");

    try {
      const {isolated, continuous, config} = await loadDbContext();
      const datesAsc = [...listAvailableDays(storage!)].sort();
      const comparison = buildComparison(isolated, continuous, config, datesAsc);

      console.log("\nFull DB daily savings comparison");
      console.table(comparison.dailyRows);
      console.log("\nFull DB totals");
      console.table([comparison.totals]);
      expect(comparison.dailyRows.length).toBeGreaterThan(30);
    } finally {
      storage?.onModuleDestroy();
      storage = null;
      if (previousStoragePath == null) {
        delete process.env.CHARGECASTER_STORAGE_PATH;
      } else {
        process.env.CHARGECASTER_STORAGE_PATH = previousStoragePath;
      }
    }
  });
});
