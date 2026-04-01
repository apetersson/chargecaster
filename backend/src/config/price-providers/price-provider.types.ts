import type { HistoryPoint, PriceSlot, RawForecastEntry, SimulationConfig } from "@chargecaster/domain";
import type { StorageService } from "../../storage/storage.service";
import type { ConfigDocument, FeedInProviderRef, GridFeeProviderRef } from "../schemas";

export type GridFeeProviderType = Exclude<GridFeeProviderRef["type"], "static">;
export type FeedInProviderType = Exclude<FeedInProviderRef["type"], "static">;

export interface PriceProviderRefreshContext {
  config: ConfigDocument;
  referenceDate: Date;
  storage: StorageService;
  timeZone: string;
}

export interface GridFeeTariffScheduleContext {
  config: ConfigDocument;
  simulationConfig: SimulationConfig;
  referenceDate: Date;
  storage: StorageService;
  forecast?: RawForecastEntry[];
  history?: HistoryPoint[];
}

export interface FeedInTariffScheduleContext {
  config: ConfigDocument;
  simulationConfig: SimulationConfig;
  referenceDate: Date;
  forecast?: RawForecastEntry[];
  history?: HistoryPoint[];
  slots?: PriceSlot[];
}

export interface GridFeePriceProvider {
  readonly type: GridFeeProviderType;
  refresh(context: PriceProviderRefreshContext): Promise<void>;
}

export interface GridFeeTariffScheduleProvider extends GridFeePriceProvider {
  buildTariffSchedule(context: GridFeeTariffScheduleContext): (number | undefined)[] | null;
  resolvePriceAt(context: GridFeeTariffScheduleContext, timestamp: string): number | null;
}

export interface FeedInPriceProvider {
  readonly type: FeedInProviderType;
  refresh(context: PriceProviderRefreshContext): Promise<void>;
}

export interface FeedInTariffScheduleProvider extends FeedInPriceProvider {
  buildTariffSchedule(context: FeedInTariffScheduleContext): (number | undefined)[] | null;
}
