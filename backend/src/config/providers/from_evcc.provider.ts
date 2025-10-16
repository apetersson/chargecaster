import { MarketProvider, MarketProviderContext, MarketProviderResult } from "./provider.types";
import { z } from "zod";
import type { RawForecastEntry } from "../../simulation/types";
import { derivePriceSnapshotFromForecast } from "./provider.utils";

export const fromEvccConfigSchema = z.object({
  priority: z.number().int().nonnegative(),
}).strip();
export type FromEvccConfig = z.infer<typeof fromEvccConfigSchema>;

export class FromEvccProvider implements MarketProvider {
  readonly key = "from_evcc";
  constructor(private readonly evccForecast: RawForecastEntry[] = [], private readonly _cfg?: FromEvccConfig) {}

  collect(ctx: MarketProviderContext): Promise<MarketProviderResult> {
    const forecast = Array.isArray(this.evccForecast) ? this.evccForecast : [];
    const priceSnapshot = derivePriceSnapshotFromForecast(forecast, ctx.simulationConfig);
    return Promise.resolve({forecast, priceSnapshot});
  }
}
