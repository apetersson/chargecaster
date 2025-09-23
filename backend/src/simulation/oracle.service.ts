import { Injectable } from "@nestjs/common";
import type { OracleEntry, OracleResponse, SnapshotPayload } from "./types";

@Injectable()
export class OracleService {
  build(snapshot: SnapshotPayload): OracleResponse {
    const entries = Array.isArray(snapshot.oracle_entries)
      ? snapshot.oracle_entries.filter((entry): entry is OracleEntry => typeof entry?.era_id === "string")
      : [];
    return {generated_at: snapshot.timestamp, entries};
  }
}
