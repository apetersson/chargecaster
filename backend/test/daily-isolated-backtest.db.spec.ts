import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigFileService } from "../src/config/config-file.service";
import { SimulationConfigFactory } from "../src/config/simulation-config.factory";
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

describeDb("DailyIsolatedBacktestStrategy database smoke test", () => {
  afterAll(() => {
    storage?.onModuleDestroy();
    storage = null;
  });

  it("prints recent daily isolated backtests from sqlite", async () => {
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
      storage = new StorageService();
      const strategy = new DailyIsolatedBacktestStrategy(storage);
      const configFactory = new SimulationConfigFactory();
      const document = await configFile.loadDocument(configPath);
      const config = configFactory.create(document);
      const rows = listAvailableDays(storage).slice(0, 30)
        .map((date) => strategy.buildDailyEntry(date, config))
        .filter((entry): entry is NonNullable<typeof entry> => entry != null)
        .map((entry) => ({
          date: entry.date,
          points: entry.result.history_points_used,
          actual_eur: Number(entry.result.actual_total_cost_eur.toFixed(2)),
          auto_eur: Number(entry.result.simulated_total_cost_eur.toFixed(2)),
          adj_actual_eur: Number(entry.result.adjusted_actual_cost_eur.toFixed(2)),
          savings_eur: Number(entry.result.savings_eur.toFixed(2)),
          actual_soc: Number(entry.result.actual_final_soc_percent.toFixed(1)),
          auto_soc: Number(entry.result.simulated_final_soc_percent.toFixed(1)),
          marginal_ct_kwh: Number((entry.result.avg_price_eur_per_kwh * 100).toFixed(2)),
        }));

      console.table(rows);
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      if (previousStoragePath == null) {
        delete process.env.CHARGECASTER_STORAGE_PATH;
      } else {
        process.env.CHARGECASTER_STORAGE_PATH = previousStoragePath;
      }
    }
  });
});
