import type {
  ForecastEra,
  ForecastResponse,
  ForecastSourcePayload,
  HistoryPoint,
  HistoryResponse,
  OracleEntry,
  OracleResponse,
  SnapshotSummary as BackendSnapshotSummary,
} from "@backend/simulation-types";

export type SnapshotSummary = BackendSnapshotSummary;
export type {
  HistoryPoint,
  HistoryResponse,
  ForecastEra,
  ForecastResponse,
  OracleEntry,
  OracleResponse,
  ForecastSourcePayload,
};
