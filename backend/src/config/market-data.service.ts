import { Injectable, Logger } from "@nestjs/common";

import type { RawForecastEntry, SimulationConfig } from "../simulation/types";
import { parseTimestamp } from "../simulation/solar";
import type { ConfigDocument } from "./schemas";
import { AwattarProvider } from "./providers/awattar.provider";
import { EntsoeNewProvider } from "./providers/entsoe_new.provider";
import { FromEvccProvider } from "./providers/from_evcc.provider";
import type { MarketProvider, MarketProviderContext } from "./providers/provider.types";

const SLOT_DURATION_MS = 3_600_000;

@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);

  async collect(
    config: ConfigDocument["market_data"] | undefined,
    simulationConfig: SimulationConfig,
    warnings: string[],
    evccFallback?: RawForecastEntry[],
  ): Promise<{ forecast: RawForecastEntry[]; priceSnapshot: number | null }> {
    const providers: { key: "entsoe"|"awattar"|"from_evcc"; prio: number }[] = [];
    if (config?.awattar) providers.push({key: "awattar", prio: config.awattar.priority});
    if (config?.entsoe) providers.push({key: "entsoe", prio: config.entsoe.priority});
    if (config?.from_evcc) providers.push({key: "from_evcc", prio: config.from_evcc.priority});
    providers.sort((a, b) => a.prio - b.prio);

    const awattarCfg = config?.awattar;
    const entsoeCfg = config?.entsoe;
    const fromEvccCfg = config?.from_evcc;

    for (const p of providers) {
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
      } else if (p.key === "from_evcc") {
        if (!fromEvccCfg) {
          throw new Error("market_data.from_evcc is referenced by priority but missing in config");
        }
        impl = new FromEvccProvider(Array.isArray(evccFallback) ? evccFallback : [], fromEvccCfg);
      }
      if (!impl) continue;
      const ctx: MarketProviderContext = {simulationConfig, warnings};
      const {forecast, priceSnapshot} = await impl.collect(ctx);
      if (forecast.length) {
        return {forecast, priceSnapshot};
      }
    }
    return {forecast: [], priceSnapshot: null};
  }

  private normalizeMarketEntries(entries: RawForecastEntry[], maxHours = 72): RawForecastEntry[] {
    const records: RawForecastEntry[] = [];
    if (!entries.length) {
      return records;
    }

    const now = Date.now();
    for (const entry of entries) {
      if (!entry) continue;
      const startTimestamp = parseTimestamp(entry.start ?? entry.from ?? null);
      const endTimestamp = parseTimestamp(entry.end ?? entry.to ?? null);
      if (!startTimestamp || !endTimestamp) {
        continue;
      }
      if (startTimestamp.getTime() < now - SLOT_DURATION_MS) {
        continue;
      }
      const durationHours = (endTimestamp.getTime() - startTimestamp.getTime()) / 3_600_000;
      if (!Number.isFinite(durationHours) || durationHours <= 0 || durationHours > maxHours) {
        continue;
      }
      records.push(entry);
    }
    return records;
  }
}
