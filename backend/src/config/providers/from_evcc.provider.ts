import { Logger } from "@nestjs/common";
import type { RawForecastEntry } from "@chargecaster/domain";
import type { FromEvccConfig } from "../schemas";
import { MarketProvider, MarketProviderContext, MarketProviderResult } from "./provider.types";
import { derivePriceSnapshotFromForecast } from "./provider.utils";

export class FromEvccProvider implements MarketProvider {
  readonly key = "from_evcc";
  private readonly logger = new Logger(FromEvccProvider.name);
  constructor(private readonly evccForecast: RawForecastEntry[] = [], private readonly _cfg?: FromEvccConfig) {}

  collect(ctx: MarketProviderContext): Promise<MarketProviderResult> {
    const forecast = Array.isArray(this.evccForecast) ? this.evccForecast : [];
    const priceSnapshot = derivePriceSnapshotFromForecast(forecast, ctx.simulationConfig);
    this.logger.log(`Using EVCC-provided forecast with ${forecast.length} slot(s)`);
    this.logger.verbose(`EVCC snapshot=${priceSnapshot ?? "n/a"}`);
    return Promise.resolve({forecast, priceSnapshot});
  }
}
