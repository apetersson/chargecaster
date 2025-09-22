import { Inject, Injectable } from "@nestjs/common";
import type { HistoryPoint, HistoryRawEntry, HistoryResponse } from "./types.ts";
import { normalizeHistoryList } from "./history.serializer.ts";
import { StorageService } from "../storage/storage.service.ts";

@Injectable()
export class HistoryService {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {}

  private serialize(history: HistoryRawEntry[]): HistoryPoint[] {
    return normalizeHistoryList(history);
  }

  getHistory(limit = 96): HistoryResponse {
    const historyRecords = this.storage.listHistory(limit);
    const entries = this.serialize(historyRecords.map((i) => i.payload));
    const generated_at = historyRecords[0]?.payload?.timestamp as string | undefined;
    return { generated_at: generated_at ?? new Date().toISOString(), entries };
  }
}
