import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import type { Database } from "better-sqlite3";
import DatabaseConstructor from "better-sqlite3";

import type { BacktestResultSummary, HistoryPoint, SnapshotPayload } from "@chargecaster/domain";
import { backtestResultSummarySchema, historyPointSchema, snapshotPayloadSchema } from "@chargecaster/domain";

const RESET_DAILY_BACKTEST_SUMMARIES_FOR_RELATIVE_SOC_MIGRATION =
  "2026-03-07-reset-daily-backtest-summaries-for-relative-soc";

export interface SnapshotRecord {
  id: number;
  timestamp: string;
      payload: SnapshotPayload;
}

export interface HistoryRecord {
  id: number;
  timestamp: string;
  payload: HistoryPoint;
}

export interface DailyBacktestSummaryRecord {
  date: string;
  configFingerprint: string;
  strategy: string;
  simulatedStartSocPercent: number;
  simulatedFinalSocPercent: number;
  updatedAt: string;
  payload: BacktestResultSummary;
}

export interface HistoryDayStatRecord {
  date: string;
  firstTimestamp: string;
  lastTimestamp: string;
  pointCount: number;
}

export interface WeatherHourRecord {
  latitude: number;
  longitude: number;
  hourUtc: string;
  temperature2m: number | null;
  cloudCover: number | null;
  windSpeed10m: number | null;
  precipitationMm: number | null;
  source: string;
  updatedAt: string;
}

export interface SolarProxyHourRecord {
  latitude: number;
  longitude: number;
  kwp: number;
  tilt: number;
  azimuth: number;
  hourUtc: string;
  globalTiltedIrradiance: number | null;
  expectedPowerW: number | null;
  source: string;
  updatedAt: string;
}

@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly dbPath: string;
  private readonly db: Database;
  private readonly logger = new Logger(StorageService.name);

  constructor() {
    const override = process.env.CHARGECASTER_STORAGE_PATH?.trim();
    const resolvedPath = override && override.length > 0
      ? resolve(process.cwd(), override)
      : join(process.cwd(), "..", "data", "db", "backend.sqlite");
    const folder = dirname(resolvedPath);
    mkdirSync(folder, {recursive: true});
    this.dbPath = resolvedPath;
    this.db = new DatabaseConstructor(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.logger.log(`Storage initialised at ${this.dbPath}`);
  }

  onModuleDestroy(): void {
    this.db.close();
    this.logger.verbose("Storage connection closed");
  }

  replaceSnapshot(payload: SnapshotPayload): void {
    const timestamp = payload.timestamp;
    this.logger.log(`Replacing latest snapshot with timestamp ${timestamp}`);
    const deleteStmt = this.db.prepare("DELETE FROM snapshots");
    const insertStmt = this.db.prepare("INSERT INTO snapshots (timestamp, payload) VALUES (?, ?)");
    const txn = this.db.transaction(() => {
      deleteStmt.run();
      insertStmt.run(timestamp, JSON.stringify(payload));
    });
    txn();
  }

  appendHistory(entries: HistoryPoint[]): void {
    if (!entries.length) {
      return;
    }
    this.logger.log(`Appending ${entries.length} history entries`);
    const stmt = this.db.prepare("INSERT INTO history (timestamp, payload) VALUES (?, ?)");
    const txn = this.db.transaction((items: HistoryPoint[]) => {
      for (const entry of items) {
        stmt.run(entry.timestamp, JSON.stringify(entry));
      }
    });
    txn(entries);
  }

  getLatestSnapshot(): SnapshotRecord | null {
    this.logger.verbose("Fetching latest snapshot from storage");
    const stmt = this.db.prepare("SELECT id, timestamp, payload FROM snapshots ORDER BY timestamp DESC LIMIT 1");
    const row = stmt.get() as { id: number; timestamp: string; payload: string } | undefined;
    if (!row) {
      return null;
    }
    const parsed = snapshotPayloadSchema.parse(JSON.parse(row.payload));
    return {
      id: row.id,
      timestamp: row.timestamp,
      payload: parsed,
    };
  }

  listHistory(limit = 96): HistoryRecord[] {
    this.logger.verbose(`Listing history entries (limit=${limit})`);
    const stmt = this.db.prepare("SELECT id, timestamp, payload FROM history ORDER BY timestamp DESC LIMIT ?");
    const rows = stmt.all(limit) as { id: number; timestamp: string; payload: string }[];
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      payload: historyPointSchema.parse(JSON.parse(row.payload)),
    }));
  }

  listAllHistoryAsc(limit?: number): HistoryRecord[] {
    this.logger.verbose(
      limit == null
        ? "Listing all history entries ASC"
        : `Listing all history entries ASC (limit=${limit})`,
    );
    const rows = (limit == null
      ? this.db.prepare("SELECT id, timestamp, payload FROM history ORDER BY timestamp ASC").all()
      : this.db.prepare("SELECT id, timestamp, payload FROM history ORDER BY timestamp ASC LIMIT ?").all(limit)
    ) as { id: number; timestamp: string; payload: string }[];
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      payload: historyPointSchema.parse(JSON.parse(row.payload)),
    }));
  }

  listHistoryRangeAsc(startInclusive: string, endExclusive: string): HistoryRecord[] {
    this.logger.verbose(`Listing history range ASC (${startInclusive}..${endExclusive})`);
    const stmt = this.db.prepare(`
      SELECT id, timestamp, payload
      FROM history
      WHERE timestamp >= ?
        AND timestamp < ?
      ORDER BY timestamp ASC
    `);
    const rows = stmt.all(startInclusive, endExclusive) as { id: number; timestamp: string; payload: string }[];
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      payload: historyPointSchema.parse(JSON.parse(row.payload)),
    }));
  }

  listHistoryDayStatsBefore(upperExclusiveDate: string): HistoryDayStatRecord[] {
    this.logger.verbose(`Listing history day stats before ${upperExclusiveDate}`);
    const stmt = this.db.prepare(`
      SELECT
        substr(timestamp, 1, 10) AS date,
        MIN(timestamp) AS first_timestamp,
        MAX(timestamp) AS last_timestamp,
        COUNT(*) AS point_count
      FROM history
      WHERE substr(timestamp, 1, 10) < ?
      GROUP BY substr(timestamp, 1, 10)
      ORDER BY date DESC
    `);
    const rows = stmt.all(upperExclusiveDate) as {
      date: string;
      first_timestamp: string;
      last_timestamp: string;
      point_count: number;
    }[];
    return rows.map((row) => ({
      date: row.date,
      firstTimestamp: row.first_timestamp,
      lastTimestamp: row.last_timestamp,
      pointCount: row.point_count,
    }));
  }

  listWeatherHours(
    latitude: number,
    longitude: number,
    startInclusive: string,
    endInclusive: string,
  ): WeatherHourRecord[] {
    this.logger.verbose(
      `Listing weather hours (${latitude.toFixed(3)},${longitude.toFixed(3)} ${startInclusive}..${endInclusive})`,
    );
    const stmt = this.db.prepare(`
      SELECT
        latitude,
        longitude,
        hour_utc,
        temperature_2m,
        cloud_cover,
        wind_speed_10m,
        precipitation_mm,
        source,
        updated_at
      FROM weather_hourly_cache
      WHERE latitude = ?
        AND longitude = ?
        AND hour_utc >= ?
        AND hour_utc <= ?
      ORDER BY hour_utc ASC
    `);
    const rows = stmt.all(latitude, longitude, startInclusive, endInclusive) as {
      latitude: number;
      longitude: number;
      hour_utc: string;
      temperature_2m: number | null;
      cloud_cover: number | null;
      wind_speed_10m: number | null;
      precipitation_mm: number | null;
      source: string;
      updated_at: string;
    }[];
    return rows.map((row) => ({
      latitude: row.latitude,
      longitude: row.longitude,
      hourUtc: row.hour_utc,
      temperature2m: row.temperature_2m,
      cloudCover: row.cloud_cover,
      windSpeed10m: row.wind_speed_10m,
      precipitationMm: row.precipitation_mm,
      source: row.source,
      updatedAt: row.updated_at,
    }));
  }

  upsertWeatherHours(entries: Omit<WeatherHourRecord, "updatedAt">[]): void {
    if (!entries.length) {
      return;
    }
    this.logger.log(`Upserting ${entries.length} weather hours`);
    const stmt = this.db.prepare(`
      INSERT INTO weather_hourly_cache (
        latitude,
        longitude,
        hour_utc,
        temperature_2m,
        cloud_cover,
        wind_speed_10m,
        precipitation_mm,
        source,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(latitude, longitude, hour_utc) DO UPDATE SET
        temperature_2m = excluded.temperature_2m,
        cloud_cover = excluded.cloud_cover,
        wind_speed_10m = excluded.wind_speed_10m,
        precipitation_mm = excluded.precipitation_mm,
        source = excluded.source,
        updated_at = excluded.updated_at
    `);
    const txn = this.db.transaction((items: Omit<WeatherHourRecord, "updatedAt">[]) => {
      const updatedAt = new Date().toISOString();
      for (const entry of items) {
        stmt.run(
          entry.latitude,
          entry.longitude,
          entry.hourUtc,
          entry.temperature2m,
          entry.cloudCover,
          entry.windSpeed10m,
          entry.precipitationMm,
          entry.source,
          updatedAt,
        );
      }
    });
    txn(entries);
  }

  listSolarProxyHours(
    latitude: number,
    longitude: number,
    kwp: number,
    tilt: number,
    azimuth: number,
    startInclusive: string,
    endInclusive: string,
  ): SolarProxyHourRecord[] {
    this.logger.verbose(
      `Listing solar proxy hours (${latitude.toFixed(3)},${longitude.toFixed(3)} tilt=${tilt} az=${azimuth} ${startInclusive}..${endInclusive})`,
    );
    const stmt = this.db.prepare(`
      SELECT
        latitude,
        longitude,
        kwp,
        tilt,
        azimuth,
        hour_utc,
        global_tilted_irradiance,
        expected_power_w,
        source,
        updated_at
      FROM solar_proxy_hourly_cache
      WHERE latitude = ?
        AND longitude = ?
        AND kwp = ?
        AND tilt = ?
        AND azimuth = ?
        AND hour_utc >= ?
        AND hour_utc <= ?
      ORDER BY hour_utc ASC
    `);
    const rows = stmt.all(latitude, longitude, kwp, tilt, azimuth, startInclusive, endInclusive) as {
      latitude: number;
      longitude: number;
      kwp: number;
      tilt: number;
      azimuth: number;
      hour_utc: string;
      global_tilted_irradiance: number | null;
      expected_power_w: number | null;
      source: string;
      updated_at: string;
    }[];
    return rows.map((row) => ({
      latitude: row.latitude,
      longitude: row.longitude,
      kwp: row.kwp,
      tilt: row.tilt,
      azimuth: row.azimuth,
      hourUtc: row.hour_utc,
      globalTiltedIrradiance: row.global_tilted_irradiance,
      expectedPowerW: row.expected_power_w,
      source: row.source,
      updatedAt: row.updated_at,
    }));
  }

  upsertSolarProxyHours(entries: Omit<SolarProxyHourRecord, "updatedAt">[]): void {
    if (!entries.length) {
      return;
    }
    this.logger.log(`Upserting ${entries.length} solar proxy hours`);
    const stmt = this.db.prepare(`
      INSERT INTO solar_proxy_hourly_cache (
        latitude,
        longitude,
        kwp,
        tilt,
        azimuth,
        hour_utc,
        global_tilted_irradiance,
        expected_power_w,
        source,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(latitude, longitude, kwp, tilt, azimuth, hour_utc) DO UPDATE SET
        global_tilted_irradiance = excluded.global_tilted_irradiance,
        expected_power_w = excluded.expected_power_w,
        source = excluded.source,
        updated_at = excluded.updated_at
    `);
    const txn = this.db.transaction((items: Omit<SolarProxyHourRecord, "updatedAt">[]) => {
      const updatedAt = new Date().toISOString();
      for (const entry of items) {
        stmt.run(
          entry.latitude,
          entry.longitude,
          entry.kwp,
          entry.tilt,
          entry.azimuth,
          entry.hourUtc,
          entry.globalTiltedIrradiance,
          entry.expectedPowerW,
          entry.source,
          updatedAt,
        );
      }
    });
    txn(entries);
  }

  upsertDailyBacktestSummaries(entries: {
    date: string;
    configFingerprint: string;
    strategy: string;
    simulatedStartSocPercent: number;
    simulatedFinalSocPercent: number;
    payload: BacktestResultSummary;
  }[]): void {
    if (!entries.length) {
      return;
    }
    this.logger.log(`Upserting ${entries.length} daily backtest summaries`);
    const stmt = this.db.prepare(`
      INSERT INTO daily_backtest_summaries (
        date,
        config_fingerprint,
        strategy,
        simulated_start_soc_percent,
        simulated_final_soc_percent,
        updated_at,
        payload
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(date, config_fingerprint) DO UPDATE SET
        strategy = excluded.strategy,
        simulated_start_soc_percent = excluded.simulated_start_soc_percent,
        simulated_final_soc_percent = excluded.simulated_final_soc_percent,
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `);
    const txn = this.db.transaction((items: typeof entries) => {
      const updatedAt = new Date().toISOString();
      for (const entry of items) {
        stmt.run(
          entry.date,
          entry.configFingerprint,
          entry.strategy,
          entry.simulatedStartSocPercent,
          entry.simulatedFinalSocPercent,
          updatedAt,
          JSON.stringify(entry.payload),
        );
      }
    });
    txn(entries);
  }

  listDailyBacktestSummaries(configFingerprint: string, dates: string[]): DailyBacktestSummaryRecord[] {
    if (!dates.length) {
      return [];
    }
    this.logger.verbose(
      `Listing daily backtest summaries (config=${configFingerprint.slice(0, 8)}, dates=${dates.length})`,
    );
    const placeholders = dates.map(() => "?").join(", ");
    const stmt = this.db.prepare(`
      SELECT
        date,
        config_fingerprint,
        strategy,
        simulated_start_soc_percent,
        simulated_final_soc_percent,
        updated_at,
        payload
      FROM daily_backtest_summaries
      WHERE config_fingerprint = ?
        AND date IN (${placeholders})
      ORDER BY date DESC
    `);
    const rows = stmt.all(configFingerprint, ...dates) as {
      date: string;
      config_fingerprint: string;
      strategy: string;
      simulated_start_soc_percent: number;
      simulated_final_soc_percent: number;
      updated_at: string;
      payload: string;
    }[];
    return rows.map((row) => ({
      date: row.date,
      configFingerprint: row.config_fingerprint,
      strategy: row.strategy,
      simulatedStartSocPercent: row.simulated_start_soc_percent,
      simulatedFinalSocPercent: row.simulated_final_soc_percent,
      updatedAt: row.updated_at,
      payload: backtestResultSummarySchema.parse(JSON.parse(row.payload)),
    }));
  }

  private migrate(): void {
    this.logger.verbose("Ensuring storage schema is up to date");
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS snapshots
        (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            payload   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON snapshots (timestamp DESC);
    `);

    this.db.exec(`
        CREATE TABLE IF NOT EXISTS history
        (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp TEXT NOT NULL,
            payload   TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_history_timestamp ON history (timestamp DESC);
    `);

    this.db.exec(`
        CREATE TABLE IF NOT EXISTS daily_backtest_summaries
        (
            date               TEXT NOT NULL,
            config_fingerprint TEXT NOT NULL,
            strategy           TEXT NOT NULL DEFAULT 'continuous',
            simulated_start_soc_percent REAL NOT NULL DEFAULT 0,
            simulated_final_soc_percent REAL NOT NULL DEFAULT 0,
            updated_at         TEXT NOT NULL,
            payload            TEXT NOT NULL,
            PRIMARY KEY (date, config_fingerprint)
        );
        CREATE INDEX IF NOT EXISTS idx_daily_backtest_summaries_date
          ON daily_backtest_summaries (date DESC);
        CREATE INDEX IF NOT EXISTS idx_daily_backtest_summaries_config
          ON daily_backtest_summaries (config_fingerprint, date DESC);
    `);
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS app_migrations
        (
            id         TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        );
    `);
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS weather_hourly_cache
        (
            latitude         REAL NOT NULL,
            longitude        REAL NOT NULL,
            hour_utc         TEXT NOT NULL,
            temperature_2m   REAL,
            cloud_cover      REAL,
            wind_speed_10m   REAL,
            precipitation_mm REAL,
            source           TEXT NOT NULL,
            updated_at       TEXT NOT NULL,
            PRIMARY KEY (latitude, longitude, hour_utc)
        );
        CREATE INDEX IF NOT EXISTS idx_weather_hourly_cache_lookup
          ON weather_hourly_cache (latitude, longitude, hour_utc);
    `);
    this.db.exec(`
        CREATE TABLE IF NOT EXISTS solar_proxy_hourly_cache
        (
            latitude                 REAL NOT NULL,
            longitude                REAL NOT NULL,
            kwp                      REAL NOT NULL,
            tilt                     REAL NOT NULL,
            azimuth                  REAL NOT NULL,
            hour_utc                 TEXT NOT NULL,
            global_tilted_irradiance REAL,
            expected_power_w         REAL,
            source                   TEXT NOT NULL,
            updated_at               TEXT NOT NULL,
            PRIMARY KEY (latitude, longitude, kwp, tilt, azimuth, hour_utc)
        );
        CREATE INDEX IF NOT EXISTS idx_solar_proxy_hourly_cache_lookup
          ON solar_proxy_hourly_cache (latitude, longitude, kwp, tilt, azimuth, hour_utc);
    `);

    const hadStrategyColumn = this.tableHasColumn("daily_backtest_summaries", "strategy");
    const hadSimStartColumn = this.tableHasColumn("daily_backtest_summaries", "simulated_start_soc_percent");
    const hadSimFinalColumn = this.tableHasColumn("daily_backtest_summaries", "simulated_final_soc_percent");

    this.addColumnIfMissing(
      "daily_backtest_summaries",
      "strategy",
      "TEXT NOT NULL DEFAULT 'continuous'",
    );
    this.addColumnIfMissing(
      "daily_backtest_summaries",
      "simulated_start_soc_percent",
      "REAL NOT NULL DEFAULT 0",
    );
    this.addColumnIfMissing(
      "daily_backtest_summaries",
      "simulated_final_soc_percent",
      "REAL NOT NULL DEFAULT 0",
    );

    if (!hadStrategyColumn || !hadSimStartColumn || !hadSimFinalColumn) {
      const deleted = this.db.prepare("DELETE FROM daily_backtest_summaries").run().changes;
      if (deleted > 0) {
        this.logger.log(`Cleared ${deleted} legacy daily backtest summaries after continuous migration`);
      }
      return;
    }

    const deleted = this.db.prepare(`
      DELETE FROM daily_backtest_summaries
      WHERE strategy IS NULL OR strategy != 'continuous'
    `).run().changes;
    if (deleted > 0) {
      this.logger.log(`Removed ${deleted} non-continuous daily backtest summaries`);
    }

    this.applyOneTimeMigration(RESET_DAILY_BACKTEST_SUMMARIES_FOR_RELATIVE_SOC_MIGRATION, () => {
      const cleared = this.db.prepare("DELETE FROM daily_backtest_summaries").run().changes;
      this.logger.log(`Cleared ${cleared} daily backtest summaries for relative-SOC accounting migration`);
    });
  }

  private tableHasColumn(table: string, column: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return rows.some((row) => row.name === column);
  }

  private addColumnIfMissing(table: string, column: string, definition: string): void {
    if (this.tableHasColumn(table, column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private applyOneTimeMigration(id: string, action: () => void): void {
    const existing = this.db.prepare("SELECT id FROM app_migrations WHERE id = ?").get(id) as { id: string } | undefined;
    if (existing) {
      return;
    }

    const txn = this.db.transaction(() => {
      action();
      this.db.prepare("INSERT INTO app_migrations (id, applied_at) VALUES (?, ?)").run(id, new Date().toISOString());
    });
    txn();
  }
}
