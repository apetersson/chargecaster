import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import type { Database } from "better-sqlite3";
import DatabaseConstructor from "better-sqlite3";

import type { BacktestResultSummary, HistoryPoint, SnapshotPayload } from "@chargecaster/domain";
import { backtestResultSummarySchema, historyPointSchema, snapshotPayloadSchema } from "@chargecaster/domain";

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
  updatedAt: string;
  payload: BacktestResultSummary;
}

export interface HistoryDayStatRecord {
  date: string;
  firstTimestamp: string;
  lastTimestamp: string;
  pointCount: number;
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

  upsertDailyBacktestSummaries(entries: {
    date: string;
    configFingerprint: string;
    payload: BacktestResultSummary;
  }[]): void {
    if (!entries.length) {
      return;
    }
    this.logger.log(`Upserting ${entries.length} daily backtest summaries`);
    const stmt = this.db.prepare(`
      INSERT INTO daily_backtest_summaries (date, config_fingerprint, updated_at, payload)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(date, config_fingerprint) DO UPDATE SET
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `);
    const txn = this.db.transaction((items: typeof entries) => {
      const updatedAt = new Date().toISOString();
      for (const entry of items) {
        stmt.run(entry.date, entry.configFingerprint, updatedAt, JSON.stringify(entry.payload));
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
      SELECT date, config_fingerprint, updated_at, payload
      FROM daily_backtest_summaries
      WHERE config_fingerprint = ?
        AND date IN (${placeholders})
      ORDER BY date DESC
    `);
    const rows = stmt.all(configFingerprint, ...dates) as {
      date: string;
      config_fingerprint: string;
      updated_at: string;
      payload: string;
    }[];
    return rows.map((row) => ({
      date: row.date,
      configFingerprint: row.config_fingerprint,
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
            updated_at         TEXT NOT NULL,
            payload            TEXT NOT NULL,
            PRIMARY KEY (date, config_fingerprint)
        );
        CREATE INDEX IF NOT EXISTS idx_daily_backtest_summaries_date
          ON daily_backtest_summaries (date DESC);
        CREATE INDEX IF NOT EXISTS idx_daily_backtest_summaries_config
          ON daily_backtest_summaries (config_fingerprint, date DESC);
    `);
  }
}
