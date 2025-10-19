import { MarketProvider, MarketProviderContext, MarketProviderResult } from "./provider.types";
import type { RawForecastEntry } from "@chargecaster/domain";
import type { FromEvccConfig } from "../schemas";
import { derivePriceSnapshotFromForecast } from "./provider.utils";

export class FromEvccProvider implements MarketProvider {
  readonly key = "from_evcc";
  constructor(private readonly evccForecast: RawForecastEntry[] = [], private readonly _cfg?: FromEvccConfig) {}

  collect(ctx: MarketProviderContext): Promise<MarketProviderResult> {
    const forecast = Array.isArray(this.evccForecast) ? this.evccForecast : [];
    const priceSnapshot = derivePriceSnapshotFromForecast(forecast, ctx.simulationConfig);
    return Promise.resolve({forecast, priceSnapshot});
  }
}
