import { Injectable, Logger } from "@nestjs/common";
import type { OracleEntry, OracleResponse, SnapshotPayload } from "@chargecaster/domain";

const isOracleEntry = (value: unknown): value is OracleEntry => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as { era_id?: unknown };
  return typeof candidate.era_id === "string";
};

@Injectable()
export class OracleService {
  private readonly logger = new Logger(OracleService.name);

  build(snapshot: SnapshotPayload): OracleResponse {
    this.logger.log(`Serializing oracle entries (total=${Array.isArray(snapshot.oracle_entries) ? snapshot.oracle_entries.length : 0})`);
    const entries = Array.isArray(snapshot.oracle_entries)
      ? snapshot.oracle_entries.filter(isOracleEntry)
      : [];
    this.logger.verbose(`Oracle response ready with ${entries.length} entries`);
    return {generated_at: snapshot.timestamp, entries};
  }
}
