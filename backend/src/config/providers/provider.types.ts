import type { RawForecastEntry, SimulationConfig } from "@chargecaster/domain";
import type { ConfigDocument } from "../schemas";

export interface EnergyPriceProviderContext {
  simulationConfig: SimulationConfig;
  configDocument: ConfigDocument;
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
