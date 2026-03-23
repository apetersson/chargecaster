import { Injectable, Logger } from "@nestjs/common";

import { normalizePriceSlots, type HistoryPoint } from "@chargecaster/domain";
import { parseMarketForecast, resolveEnergyPriceConfig } from "../schemas";
import type {
  FeedInTariffScheduleContext,
  FeedInTariffScheduleProvider,
  PriceProviderRefreshContext,
} from "./price-provider.types";

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_AWATTAR_MARKET_DATA_URL = "https://api.awattar.at/v1/marketdata";
const MIN_REFRESH_HOURS = 24;

@Injectable()
export class AwattarSunnySpotFeedInPriceProvider implements FeedInTariffScheduleProvider {
  readonly type = "awattar-sunny-spot" as const;
  private readonly logger = new Logger(AwattarSunnySpotFeedInPriceProvider.name);

  async refresh(context: PriceProviderRefreshContext): Promise<void> {
    const horizonHours = Math.max(
      MIN_REFRESH_HOURS,
      Math.round(resolveEnergyPriceConfig(context.config)?.awattar?.max_hours ?? 72),
    );
    const start = new Date(context.referenceDate);
    start.setUTCMinutes(0, 0, 0);
    const end = new Date(start.getTime() + horizonHours * 3_600_000);
    const url = `${DEFAULT_AWATTAR_MARKET_DATA_URL}?start=${start.getTime()}&end=${end.getTime()}`;
    this.logger.log(`Refreshing aWATTar SUNNY Spot feed-in from ${url}`);
    const payload = await this.fetchJson(url);
    const forecast = parseMarketForecast(payload);
    const slots = normalizePriceSlots(forecast);

    for (const slot of slots) {
      context.storage.upsertDynamicPriceRecord({
        priceKey: "feed_in_tariff_eur_per_kwh",
        source: this.type,
        effectiveAt: slot.start.toISOString(),
        observedAt: context.referenceDate.toISOString(),
        valueEurPerKwh: this.calculateTariffEurPerKwh(slot.price),
        metadata: {
          url,
          market_price_eur_per_kwh: slot.price,
          formula: "market - |market| * 0.19",
        },
      });
    }
  }

  buildTariffSchedule(context: FeedInTariffScheduleContext): (number | undefined)[] | null {
    if (context.slots && context.slots.length > 0) {
      return context.slots.map((slot) => this.calculateTariffEurPerKwh(slot.price));
    }

    if (context.forecast && context.forecast.length > 0) {
      const slots = normalizePriceSlots(context.forecast);
      return slots.map((slot) => this.calculateTariffEurPerKwh(slot.price));
    }

    if (context.history && context.history.length > 1) {
      return this.buildTariffsFromHistory(context.history);
    }

    return null;
  }

  private buildTariffsFromHistory(history: HistoryPoint[]): (number | undefined)[] {
    const values: (number | undefined)[] = [];
    for (let index = 0; index < history.length - 1; index += 1) {
      const current = history[index];
      const next = history[index + 1];
      const start = new Date(current.timestamp).getTime();
      const end = new Date(next.timestamp).getTime();
      const durationMs = end - start;
      if (durationMs <= 0 || durationMs > 7_200_000) {
        values.push(undefined);
        continue;
      }
      const price = Number(current.price_eur_per_kwh);
      values.push(Number.isFinite(price) ? this.calculateTariffEurPerKwh(price) : undefined);
    }
    return values;
  }

  private calculateTariffEurPerKwh(marketPriceEurPerKwh: number): number {
    return marketPriceEurPerKwh - Math.abs(marketPriceEurPerKwh) * 0.19;
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
}
