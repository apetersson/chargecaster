import { Injectable, Logger } from "@nestjs/common";
import type { ForecastEra, ForecastResponse, PriceSlot, RawForecastEntry } from "@chargecaster/domain";
import { normalizePriceSlots } from "./simulation.service";

@Injectable()
export class ForecastService {
  private readonly logger = new Logger(ForecastService.name);

  buildSlots(forecast: RawForecastEntry[]): PriceSlot[] {
    this.logger.verbose(`Normalizing ${forecast.length} forecast entries into price slots`);
    return normalizePriceSlots(forecast);
  }

  buildResponse(timestamp: string | null, eras: ForecastEra[] | undefined | null): ForecastResponse {
    this.logger.log(
      `Building forecast response (eras=${Array.isArray(eras) ? eras.length : 0}, timestamp=${timestamp ?? "n/a"})`,
    );
    return {generated_at: timestamp, eras: Array.isArray(eras) ? eras : []};
  }
}
