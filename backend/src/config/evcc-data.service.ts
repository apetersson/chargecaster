import { Injectable, Logger } from "@nestjs/common";

import type { RawForecastEntry, RawSolarEntry } from "@chargecaster/domain";
import { describeError } from "@chargecaster/domain";
import { buildSolarForecastFromTimeseries } from "../simulation/solar";
import type { ConfigDocument } from "./schemas";
import { parseEvccState } from "./schemas";

const REQUEST_TIMEOUT_MS = 15000;

@Injectable()
export class EvccDataService {
  private readonly logger = new Logger(EvccDataService.name);

  async collect(
    config: ConfigDocument["evcc"],
    warnings: string[],
  ): Promise<{
    forecast: RawForecastEntry[];
    solarForecast: RawSolarEntry[];
    priceSnapshot: number | null;
    batterySoc: number | null;
    gridPowerW: number | null;
    solarPowerW: number | null;
    homePowerW: number | null;
  }> {
    const {
      enabled = true,
      base_url: baseUrl,
      timeout_ms: timeoutMsOverride,
      token,
    } = config ?? {};
    const timeoutMs = timeoutMsOverride ?? REQUEST_TIMEOUT_MS;
    const tokenValue = typeof token === "string" && token.length > 0 ? token : null;

    if (!enabled) {
      warnings.push("EVCC data fetch disabled in config.");
      this.logger.warn("EVCC data fetch disabled in config.");
      return this.emptyResult();
    }

    if (!baseUrl) {
      const message = "EVCC base_url not configured; skipping EVCC forecast.";
      warnings.push(message);
      this.logger.warn(message);
      return this.emptyResult();
    }

    let endpoint: string;
    try {
      endpoint = new URL("/api/state", baseUrl).toString();
    } catch (error) {
      const message = `Invalid EVCC base_url (${baseUrl}): ${describeError(error)}`;
      warnings.push(message);
      this.logger.warn(message);
      return this.emptyResult();
    }

    const headers: Record<string, string> = {};
    if (tokenValue) {
      headers.Authorization = `Bearer ${tokenValue}`;
    }

    try {
      this.logger.log(`Fetching EVCC state from ${endpoint}`);
      const payload = await this.fetchJson(endpoint, timeoutMs, {
        headers: Object.keys(headers).length ? headers : undefined,
      });

      const parsed = parseEvccState(payload);
      const solarForecast = buildSolarForecastFromTimeseries(parsed.solarTimeseries);

      return {
        forecast: parsed.forecast,
        solarForecast,
        priceSnapshot: parsed.priceSnapshot,
        batterySoc: parsed.batterySoc,
        gridPowerW: parsed.gridPowerW,
        solarPowerW: parsed.solarPowerW,
        homePowerW: parsed.homePowerW,
      };
    } catch (error) {
      const message = `EVCC data fetch failed: ${describeError(error)}`;
      warnings.push(message);
      this.logger.warn(message);
      return this.emptyResult();
    }
  }

  private emptyResult(): {
    forecast: RawForecastEntry[];
    solarForecast: RawSolarEntry[];
    priceSnapshot: number | null;
    batterySoc: number | null;
    gridPowerW: number | null;
    solarPowerW: number | null;
    homePowerW: number | null;
  } {
    return {
      forecast: [],
      solarForecast: [],
      priceSnapshot: null,
      batterySoc: null,
      gridPowerW: null,
      solarPowerW: null,
      homePowerW: null,
    };
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

}
