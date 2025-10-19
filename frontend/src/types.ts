import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@backend/trpc";

export type {
  HistoryPoint,
  HistoryResponse,
  ForecastEra,
  ForecastResponse,
  ForecastSourcePayload,
  OracleEntry,
  OracleResponse,
  SnapshotSummary,
  BacktestSeriesResponse,
  BacktestSeriesPoint,
} from "@chargecaster/domain";

export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type DashboardOutputs = RouterOutputs["dashboard"];
