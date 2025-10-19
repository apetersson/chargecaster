import { Inject, Injectable } from "@nestjs/common";
import type { HistoryPoint, HistoryResponse } from "@chargecaster/domain";
import { normalizeHistoryList } from "./history.serializer";
import { StorageService } from "../storage/storage.service";

@Injectable()
export class HistoryService {
  constructor(@Inject(StorageService) private readonly storage: StorageService) {
  }

  getHistory(limit = 96): HistoryResponse {
    const historyRecords = this.storage.listHistory(limit);
    const entries = this.serialize(historyRecords.map((i) => i.payload));
    const generated_at = historyRecords[0]?.payload?.timestamp as string | undefined;
    return {generated_at: generated_at ?? new Date().toISOString(), entries};
  }

  private serialize(history: HistoryPoint[]): HistoryPoint[] {
    return normalizeHistoryList(history);
  }
}
