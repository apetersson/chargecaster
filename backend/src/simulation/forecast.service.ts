import { Injectable } from "@nestjs/common";
import type { ForecastEra, ForecastResponse, PriceSlot } from "./types.js";
import { normalizePriceSlots } from "./simulation.service.js";

@Injectable()
export class ForecastService {
  buildSlots(forecast: Record<string, unknown>[]): PriceSlot[] {
    return normalizePriceSlots(forecast);
  }

  buildResponse(timestamp: string, eras: ForecastEra[] | undefined | null): ForecastResponse {
    return { generated_at: timestamp, eras: Array.isArray(eras) ? eras : [] };
  }
}
