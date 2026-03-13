import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import DatabaseConstructor from "better-sqlite3";
import YAML from "yaml";
import { describe, expect, it } from "vitest";

import type { HistoryPoint, SnapshotPayload } from "@chargecaster/domain";
import { DemandForecastService } from "../src/config/demand-forecast.service";
import { parseConfigDocument } from "../src/config/schemas";
import { WeatherService } from "../src/config/weather.service";
import type { StorageService, WeatherHourRecord } from "../src/storage/storage.service";

type HistoryRow = {
  id: number;
  timestamp: string;
  payload: HistoryPoint;
};

describe("Demand forecast smoke", () => {
  it("loads the current DB and prints a forecast table", async () => {
    const dbPath = join(process.cwd(), "..", "data", "db", "backend.sqlite");
    const configPath = join(process.cwd(), "..", "config.local.yaml");
    if (!existsSync(dbPath) || !existsSync(configPath)) {
      return;
    }

    const db = new DatabaseConstructor(dbPath, { readonly: true, fileMustExist: true });
    const historyRows = db.prepare("SELECT id, timestamp, payload FROM history ORDER BY timestamp ASC").all() as {
      id: number;
      timestamp: string;
      payload: string;
    }[];
    const snapshotRow = db.prepare("SELECT payload FROM snapshots ORDER BY timestamp DESC LIMIT 1").get() as {
      payload: string;
    } | undefined;
    db.close();

    expect(historyRows.length).toBeGreaterThan(0);
    expect(snapshotRow).toBeDefined();
    if (!snapshotRow) {
      return;
    }

    const config = parseConfigDocument(YAML.parse(readFileSync(configPath, "utf-8")));
    const snapshot = JSON.parse(snapshotRow.payload) as SnapshotPayload;
    const history = historyRows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      payload: JSON.parse(row.payload) as HistoryPoint,
    })) satisfies HistoryRow[];
    const latestHistory = history.at(-1)?.payload ?? null;

    const weatherCache: WeatherHourRecord[] = [];
    const storage = {
      listAllHistoryAsc: () => history,
      listWeatherHours: (_lat: number, _lon: number, startInclusive: string, endInclusive: string) =>
        weatherCache.filter((entry) => entry.hourUtc >= startInclusive && entry.hourUtc <= endInclusive),
      upsertWeatherHours: (entries: Omit<WeatherHourRecord, "updatedAt">[]) => {
        const updatedAt = new Date().toISOString();
        for (const entry of entries) {
          const existingIndex = weatherCache.findIndex((candidate) =>
            candidate.latitude === entry.latitude &&
            candidate.longitude === entry.longitude &&
            candidate.hourUtc === entry.hourUtc
          );
          const normalized: WeatherHourRecord = { ...entry, updatedAt };
          if (existingIndex >= 0) {
            weatherCache[existingIndex] = normalized;
          } else {
            weatherCache.push(normalized);
          }
        }
      },
    } as unknown as StorageService;
    const weatherService = new WeatherService(storage);
    const demandForecastService = new DemandForecastService(storage, weatherService);

    const forecast = await demandForecastService.buildForecast({
      config,
      forecastEras: Array.isArray(snapshot.forecast_eras) ? snapshot.forecast_eras : [],
      liveHomePowerW: latestHistory?.home_power_w ?? null,
      liveEvChargePowerW: latestHistory?.ev_charge_power_w ?? null,
      evConnected: (latestHistory?.ev_charge_power_w ?? 0) > 0,
      evCharging: (latestHistory?.ev_charge_power_w ?? 0) > 0,
    });

    expect(forecast.length).toBeGreaterThan(0);
    const rows = forecast.slice(0, 12).map((entry) => ({
      start: entry.start,
      house_power_w: Math.round(entry.house_power_w),
      direct_pv_use_w: Math.round(entry.direct_pv_use_w),
      residual_house_power_w: Math.round(entry.residual_house_power_w),
      ev_power_w: Math.round(entry.ev_power_w),
      total_power_w: Math.round(entry.total_power_w),
      confidence: entry.confidence != null ? entry.confidence.toFixed(3) : "n/a",
    }));
    const header = ["start", "house", "direct_pv", "residual", "ev", "total", "confidence"];
    const lines = rows.map((row) =>
      [
        row.start,
        String(row.house_power_w),
        String(row.direct_pv_use_w),
        String(row.residual_house_power_w),
        String(row.ev_power_w),
        String(row.total_power_w),
        row.confidence,
      ].join("\t"),
    );
    process.stdout.write(`\nDemand forecast smoke table\n${header.join("\t")}\n${lines.join("\n")}\n`);
  }, 30_000);
});
