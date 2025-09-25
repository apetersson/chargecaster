import type { HistoryPoint, HistoryRawEntry } from "./types";
import { historyPointSchema } from "./types";

function toHistoryPoint(entry: HistoryPoint | HistoryRawEntry): HistoryPoint {
  return historyPointSchema.parse(entry as HistoryRawEntry);
}

export function normalizeHistoryEntry(entry: HistoryPoint | HistoryRawEntry): HistoryPoint {
  return toHistoryPoint(entry);
}

export function normalizeHistoryList(entries: (HistoryPoint | HistoryRawEntry)[]): HistoryPoint[] {
  return entries
    .map((entry) => toHistoryPoint(entry))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}
