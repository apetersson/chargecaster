import { Injectable, Logger } from "@nestjs/common";
import type { ForecastEra, ForecastResponse } from "@chargecaster/domain";

@Injectable()
export class ForecastService {
  private readonly logger = new Logger(ForecastService.name);

  buildResponse(timestamp: string, eras: ForecastEra[] | undefined | null): ForecastResponse {
    this.logger.log(
      `Building forecast response (eras=${Array.isArray(eras) ? eras.length : 0}, timestamp=${timestamp})`,
    );
    return {generated_at: timestamp, eras: Array.isArray(eras) ? eras : []};
  }
}
