import { Injectable, Logger } from "@nestjs/common";

import type { FeedInPriceProvider, PriceProviderRefreshContext } from "./price-provider.types";

const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_AWATTAR_SUNNY_URL = "https://www.awattar.at/tariffs/sunny";

@Injectable()
export class AwattarSunnyFeedInPriceProvider implements FeedInPriceProvider {
  readonly type = "awattar-sunny" as const;
  private readonly logger = new Logger(AwattarSunnyFeedInPriceProvider.name);

  async refresh(context: PriceProviderRefreshContext): Promise<void> {
    const url = context.config.price?.dynamic?.awattar_sunny?.url?.trim() || DEFAULT_AWATTAR_SUNNY_URL;
    this.logger.log(`Refreshing aWATTar SUNNY feed-in from ${url}`);
    const html = await this.fetchText(url);
    const match = /Einspeiseverg(?:ü|u)tung[\s\S]*?([0-9]+(?:[.,][0-9]+)?)\s*Cent\/kWh/i.exec(html);
    if (!match?.[1]) {
      throw new Error("Could not find current SUNNY feed-in tariff on the tariff page.");
    }

    const valueEurPerKwh = this.parseEuropeanNumber(match[1]) / 100;
    const effectiveAt = this.resolveMonthStartIso(context.referenceDate, context.timeZone);
    context.storage.upsertDynamicPriceRecord({
      priceKey: "feed_in_tariff_eur_per_kwh",
      source: this.type,
      effectiveAt,
      observedAt: context.referenceDate.toISOString(),
      valueEurPerKwh,
      metadata: {
        url,
        raw_value: match[1],
        unit: "cent_per_kwh",
      },
    });
  }

  private resolveMonthStartIso(referenceDate: Date, timeZone: string): string {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
    });
    const parts = formatter.formatToParts(referenceDate);
    const year = parts.find((part) => part.type === "year")?.value ?? referenceDate.getUTCFullYear().toString();
    const month = parts.find((part) => part.type === "month")?.value ?? `${referenceDate.getUTCMonth() + 1}`.padStart(2, "0");
    return this.resolveLocalMidnightUtcIso(Number(year), Number(month), 1, timeZone);
  }

  private resolveLocalMidnightUtcIso(year: number, month: number, day: number, timeZone: string): string {
    const initialGuessUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);
    const offsetMs = this.resolveTimeZoneOffsetMs(new Date(initialGuessUtcMs), timeZone);
    const resolvedUtcMs = initialGuessUtcMs - offsetMs;
    const correctedOffsetMs = this.resolveTimeZoneOffsetMs(new Date(resolvedUtcMs), timeZone);
    return new Date(initialGuessUtcMs - correctedOffsetMs).toISOString();
  }

  private resolveTimeZoneOffsetMs(date: Date, timeZone: string): number {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(date);
    const get = (type: string, fallback: string) => Number(parts.find((part) => part.type === type)?.value ?? fallback);
    const year = get("year", String(date.getUTCFullYear()));
    const month = get("month", String(date.getUTCMonth() + 1));
    const day = get("day", String(date.getUTCDate()));
    const hour = get("hour", String(date.getUTCHours()));
    const minute = get("minute", String(date.getUTCMinutes()));
    const second = get("second", String(date.getUTCSeconds()));
    return Date.UTC(year, month - 1, day, hour, minute, second) - date.getTime();
  }

  private parseEuropeanNumber(raw: string): number {
    const trimmed = raw.trim();
    const normalized = trimmed.includes(",")
      ? trimmed.replace(/\./g, "").replace(",", ".")
      : trimmed;
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Unable to parse numeric value '${raw}'.`);
    }
    return parsed;
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {signal: controller.signal});
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }
}
