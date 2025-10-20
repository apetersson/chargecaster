import { Injectable, Logger } from "@nestjs/common";

import type { RawForecastEntry, SimulationConfig } from "@chargecaster/domain";
import type { ConfigDocument } from "./schemas";
import { AwattarProvider } from "./providers/awattar.provider";
import { EntsoeNewProvider } from "./providers/entsoe_new.provider";
import { FromEvccProvider } from "./providers/from_evcc.provider";
import type { MarketProvider, MarketProviderContext } from "./providers/provider.types";

@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);

  async collect(
    config: ConfigDocument["market_data"] | undefined,
    simulationConfig: SimulationConfig,
    warnings: string[],
    evccFallback?: RawForecastEntry[],
  ): Promise<{ forecast: RawForecastEntry[]; priceSnapshot: number | null }> {
    const providers: { key: "entsoe" | "awattar" | "from_evcc"; prio: number }[] = [];
    if (config?.awattar) providers.push({key: "awattar", prio: config.awattar.priority});
    if (config?.entsoe) providers.push({key: "entsoe", prio: config.entsoe.priority});
    if (config?.from_evcc) providers.push({key: "from_evcc", prio: config.from_evcc.priority});
    providers.sort((a, b) => a.prio - b.prio);

    const awattarCfg = config?.awattar;
    const entsoeCfg = config?.entsoe;
    const fromEvccCfg = config?.from_evcc;

    for (const p of providers) {
      this.logger.log(`Collecting market data via provider ${p.key}`);
      let impl: MarketProvider | null = null;
      if (p.key === "awattar") {
        if (!awattarCfg) {
          throw new Error("market_data.awattar is referenced by priority but missing in config");
        }
        impl = new AwattarProvider(awattarCfg);
      } else if (p.key === "entsoe") {
        if (!entsoeCfg) {
          throw new Error("market_data.entsoe is referenced by priority but missing in config");
        }
        impl = new EntsoeNewProvider(entsoeCfg);
      } else {
        if (!fromEvccCfg) {
          throw new Error("market_data.from_evcc is referenced by priority but missing in config");
        }
        impl = new FromEvccProvider(Array.isArray(evccFallback) ? evccFallback : [], fromEvccCfg);
      }
      const ctx: MarketProviderContext = {simulationConfig, warnings};
      const {forecast, priceSnapshot} = await impl.collect(ctx);
      this.logger.verbose(
        `Provider ${p.key} returned forecast=${forecast.length}, price_snapshot=${priceSnapshot ?? "n/a"}`,
      );
      if (forecast.length) {
        return {forecast, priceSnapshot};
      }
      this.logger.warn(`Provider ${p.key} returned no usable price slots; trying next provider`);
    }
    return {forecast: [], priceSnapshot: null};
  }
}
