import { Injectable } from "@nestjs/common";
import type { ForecastEra, ForecastResponse, PriceSlot, RawForecastEntry } from "./types";
import { normalizePriceSlots } from "./simulation.service";

@Injectable()
export class ForecastService {
  buildSlots(forecast: RawForecastEntry[]): PriceSlot[] {
    return normalizePriceSlots(forecast);
  }

  buildResponse(timestamp: string, eras: ForecastEra[] | undefined | null): ForecastResponse {
    return {generated_at: timestamp, eras: Array.isArray(eras) ? eras : []};
  }
}
