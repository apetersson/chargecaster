import type { RawForecastEntry, SimulationConfig } from "@chargecaster/domain";

export interface EnergyPriceProviderContext {
  simulationConfig: SimulationConfig;
  warnings: string[];
}

export interface EnergyPriceProviderResult {
  forecast: RawForecastEntry[];
  priceSnapshot: number | null;
}

export interface EnergyPriceProvider {
  readonly key: string;
  collect(ctx: EnergyPriceProviderContext): Promise<EnergyPriceProviderResult>;
}
