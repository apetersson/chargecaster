import { MarketProvider, MarketProviderContext, MarketProviderResult } from "./provider.types";
import type { RawForecastEntry } from "../../simulation/types";
import { parseMarketForecast, type AwattarConfig } from "../schemas";
import { clampHorizon, derivePriceSnapshotFromForecast } from "./provider.utils";

const DEFAULT_MARKET_DATA_URL = "https://api.awattar.de/v1/marketdata";
const REQUEST_TIMEOUT_MS = 15000;

export class AwattarProvider implements MarketProvider {
  readonly key = "awattar";
  constructor(private readonly cfg?: AwattarConfig) {}

  async collect(ctx: MarketProviderContext): Promise<MarketProviderResult> {
    const endpoint = this.cfg?.url ?? DEFAULT_MARKET_DATA_URL;
    try {
      const payload = await this.fetchJson(endpoint);
      const entries = parseMarketForecast(payload);
      const forecast: RawForecastEntry[] = clampHorizon(entries, this.cfg?.max_hours ?? 72);
      const priceSnapshot = derivePriceSnapshotFromForecast(forecast, ctx.simulationConfig);
      return {forecast, priceSnapshot};
    } catch (error) {
      ctx.warnings.push(`Awattar fetch failed: ${this.describeError(error)}`);
      return {forecast: [], priceSnapshot: null};
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {signal: controller.signal});
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
