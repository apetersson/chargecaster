import { Logger } from "@nestjs/common";
import { derivePriceSnapshot, EnergyPrice, normalizePriceSlots, type RawForecastEntry } from "@chargecaster/domain";
import type { FromEvccConfig } from "../schemas";
import { EnergyPriceProvider, EnergyPriceProviderContext, EnergyPriceProviderResult } from "./provider.types";

export class FromEvccProvider implements EnergyPriceProvider {
  readonly key = "from_evcc";
  private readonly logger = new Logger(FromEvccProvider.name);
  constructor(private readonly evccForecast: RawForecastEntry[] = [], private readonly _cfg?: FromEvccConfig) {}

  collect(ctx: EnergyPriceProviderContext): Promise<EnergyPriceProviderResult> {
    const forecast = Array.isArray(this.evccForecast) ? this.evccForecast : [];
    const priceSnapshot = derivePriceSnapshot(
      normalizePriceSlots(forecast),
      EnergyPrice.fromEurPerKwh(ctx.simulationConfig.price.grid_fee_eur_per_kwh ?? 0),
    )?.eurPerKwh ?? null;
    this.logger.log(`Using EVCC-provided forecast with ${forecast.length} slot(s)`);
    this.logger.verbose(`EVCC snapshot=${priceSnapshot ?? "n/a"}`);
    return Promise.resolve({forecast, priceSnapshot});
  }
}
