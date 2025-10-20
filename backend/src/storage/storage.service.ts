import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import type { Database } from "better-sqlite3";
import DatabaseConstructor from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { HistoryPoint, SnapshotPayload } from "@chargecaster/domain";
import { historyPointSchema, snapshotPayloadSchema } from "@chargecaster/domain";

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

@Injectable()
export class StorageService implements OnModuleDestroy {
  private readonly dbPath = join(process.cwd(), "..", "data", "db", "backend.sqlite");
  private readonly db: Database;
  private readonly logger = new Logger(StorageService.name);

  constructor() {
    const folder = join(process.cwd(), "..", "data", "db");
    mkdirSync(folder, {recursive: true});
    this.db = new DatabaseConstructor(this.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
    this.logger.log(`Storage initialised at ${this.dbPath}`);
  }

  onModuleDestroy(): void {
    this.db.close();
    this.logger.verbose("Storage connection closed");
  }

  saveSnapshot(timestamp: string, payload: SnapshotPayload): void {
    this.logger.log(`Persisting snapshot at ${timestamp}`);
    const stmt = this.db.prepare("INSERT INTO snapshots (timestamp, payload) VALUES (?, ?)");
    stmt.run(timestamp, JSON.stringify(payload));
  }

  replaceSnapshot(payload: SnapshotPayload): void {
    const rawTimestamp = payload.timestamp;
    const timestamp = typeof rawTimestamp === "string" && rawTimestamp.length > 0 ? rawTimestamp : new Date().toISOString();
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
        const rawTimestamp = entry.timestamp;
        const timestamp = typeof rawTimestamp === "string" && rawTimestamp.length > 0 ? rawTimestamp : new Date().toISOString();
        stmt.run(timestamp, JSON.stringify(entry));
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
  }
}
