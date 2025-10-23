import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import type { Database } from "better-sqlite3";
import DatabaseConstructor from "better-sqlite3";

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
