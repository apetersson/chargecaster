import { Injectable, Logger } from "@nestjs/common";
import type { OracleEntry, OracleResponse, SnapshotPayload } from "@chargecaster/domain";

@Injectable()
export class OracleService {
  private readonly logger = new Logger(OracleService.name);

  build(snapshot: SnapshotPayload): OracleResponse {
    this.logger.log(`Serializing oracle entries (total=${Array.isArray(snapshot.oracle_entries) ? snapshot.oracle_entries.length : 0})`);
    const entries = Array.isArray(snapshot.oracle_entries)
      ? snapshot.oracle_entries.filter((entry): entry is OracleEntry => typeof entry?.era_id === "string")
      : [];
    this.logger.verbose(`Oracle response ready with ${entries.length} entries`);
    return {generated_at: snapshot.timestamp, entries};
  }
}
