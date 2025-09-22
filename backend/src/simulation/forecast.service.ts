import { Injectable } from "@nestjs/common";
import type { ForecastEra, ForecastResponse, PriceSlot, RawForecastEntry } from "./types.ts";
import { normalizePriceSlots } from "./simulation.service.ts";

@Injectable()
export class ForecastService {
  buildSlots(forecast: RawForecastEntry[]): PriceSlot[] {
    return normalizePriceSlots(forecast);
  }

  buildResponse(timestamp: string, eras: ForecastEra[] | undefined | null): ForecastResponse {
    return { generated_at: timestamp, eras: Array.isArray(eras) ? eras : [] };
  }
}
