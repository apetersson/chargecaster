import { Inject, Injectable, Logger } from "@nestjs/common";
import type { HistoryPoint, HistoryResponse } from "@chargecaster/domain";
import { StorageService } from "../storage/storage.service";
import { normalizeHistoryList } from "./history.serializer";

@Injectable()
export class HistoryService {
  private readonly logger = new Logger(HistoryService.name);

  constructor(@Inject(StorageService) private readonly storage: StorageService) {
  }

  getHistory(limit = 96): HistoryResponse {
    this.logger.log(`Reading history (limit=${limit})`);
    const historyRecords = this.storage.listHistory(limit);
    this.logger.verbose(`Fetched ${historyRecords.length} history rows from storage`);
    const entries = this.serialize(historyRecords.map((i) => i.payload));
    const generated_at = historyRecords[0]?.payload?.timestamp as string | undefined;
    return {generated_at: generated_at ?? new Date().toISOString(), entries};
  }

  private serialize(history: HistoryPoint[]): HistoryPoint[] {
    return normalizeHistoryList(history);
  }
}
