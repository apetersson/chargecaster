import type { RawForecastEntry, SimulationConfig } from "../../simulation/types";

export interface MarketProviderContext {
  simulationConfig: SimulationConfig;
  warnings: string[];
}

export interface MarketProviderResult {
  forecast: RawForecastEntry[];
  priceSnapshot: number | null;
}

export interface MarketProvider {
  readonly key: string;
  collect(ctx: MarketProviderContext): Promise<MarketProviderResult>;
}

