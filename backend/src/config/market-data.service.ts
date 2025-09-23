import { Injectable, Logger } from "@nestjs/common";

import type { RawForecastEntry, SimulationConfig } from "../simulation/types";
import { parseMarketForecast } from "./schemas";
import { normalizePriceSlots } from "../simulation/simulation.service";
import { parseTimestamp } from "../simulation/solar";
import type { ConfigDocument } from "./schemas";

const DEFAULT_MARKET_DATA_URL = "https://api.awattar.de/v1/marketdata";
const REQUEST_TIMEOUT_MS = 15000;
const SLOT_DURATION_MS = 3_600_000;

@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);

  async collect(
    config: ConfigDocument["market_data"],
    simulationConfig: SimulationConfig,
    warnings: string[],
  ): Promise<{ forecast: RawForecastEntry[]; priceSnapshot: number | null }> {
    const enabled = config?.enabled ?? true;
    if (!enabled) {
      warnings.push("Market data fetch disabled in config.");
      this.logger.warn("Market data fetch disabled in config.");
      return {forecast: [], priceSnapshot: null};
    }

    const endpoint = config?.url ?? DEFAULT_MARKET_DATA_URL;
    const maxHours = config?.max_hours ?? 72;

    try {
      this.logger.log(`Fetching market forecast from ${endpoint} (max ${maxHours}h)`);
      const payload = await this.fetchJson(endpoint, REQUEST_TIMEOUT_MS);
      const entries = parseMarketForecast(payload);
      const normalized = this.normalizeMarketEntries(entries, maxHours);
      const priceSnapshot = this.derivePriceSnapshot(normalized, simulationConfig);
      if (!normalized.length) {
        warnings.push("Market data response contained no usable price slots.");
        this.logger.warn("Market data response contained no usable price slots.");
      }
      return {forecast: normalized, priceSnapshot};
    } catch (error) {
      const message = `Market data fetch failed: ${this.describeError(error)}`;
      warnings.push(message);
      this.logger.warn(message);
      return {forecast: [], priceSnapshot: null};
    }
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

  private derivePriceSnapshot(forecast: RawForecastEntry[], config: SimulationConfig): number | null {
    if (!forecast.length) {
      return null;
    }
    const slots = normalizePriceSlots(forecast);
    if (!slots.length) {
      return null;
    }
    const basePrice = slots[0]?.price;
    if (typeof basePrice !== "number" || Number.isNaN(basePrice)) {
      return null;
    }
    const gridFee = config.price?.grid_fee_eur_per_kwh ?? 0;
    return basePrice + gridFee;
  }

  private async fetchJson(url: string, timeoutMs: number, init?: RequestInit): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {...(init ?? {}), signal: controller.signal});
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
