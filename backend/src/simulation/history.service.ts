import { Injectable } from "@nestjs/common";
import type { HistoryPoint, HistoryResponse } from "./types.js";
import { StorageService } from "../storage/storage.service.js";

@Injectable()
export class HistoryService {
  constructor(private readonly storage: StorageService) {}

  private toNullableNumber(value: unknown): number | null {
    if (value == null) return null;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  private serialize(history: Record<string, unknown>[]): HistoryPoint[] {
    const entries = history.map((entry) => {
      const ts = typeof entry.timestamp === "string" && entry.timestamp.length > 0
        ? entry.timestamp
        : new Date().toISOString();
      return {
        timestamp: ts,
        battery_soc_percent: this.toNullableNumber((entry as { battery_soc_percent?: unknown }).battery_soc_percent),
        price_ct_per_kwh: this.toNullableNumber((entry as { price_ct_per_kwh?: unknown }).price_ct_per_kwh),
        price_eur_per_kwh: this.toNullableNumber((entry as { price_eur_per_kwh?: unknown }).price_eur_per_kwh),
        grid_power_w: null,
        grid_energy_w: null,
      };
    });
    return entries.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  getHistory(limit = 96): HistoryResponse {
    const historyRecords = this.storage.listHistory(limit);
    const entries = this.serialize(historyRecords.map((i) => i.payload));
    const generated_at = historyRecords[historyRecords.length - 1]?.payload?.timestamp as string | undefined;
    return { generated_at: generated_at ?? new Date().toISOString(), entries };
  }
}
