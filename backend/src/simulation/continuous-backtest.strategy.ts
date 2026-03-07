import { Injectable } from "@nestjs/common";
import type { SimulationConfig } from "@chargecaster/domain";
import type { BuildDailyBacktestOptions, DailyBacktestEntry } from "./daily-backtest.strategy";
import { DailyIsolatedBacktestStrategy } from "./daily-isolated-backtest.strategy";

@Injectable()
export class ContinuousBacktestStrategy extends DailyIsolatedBacktestStrategy {
  override readonly name: string = "continuous";
  override readonly requiresSequentialState: boolean = true;

  override buildDailyEntry(
    date: string,
    config: SimulationConfig,
    options?: BuildDailyBacktestOptions,
  ): DailyBacktestEntry | null {
    const points = this.loadUtcDayHistory(date);
    if (points.length < 2) {
      return null;
    }
    const marginalPrice = this.resolveMarginalPrice(date, config, options);
    if (marginalPrice == null && !options?.snapshot) {
      return null;
    }

    const result = this.runForHistory(points, config, {
      snapshot: options?.snapshot,
      marginalPrice: marginalPrice ?? undefined,
      initialSimSocPercent: options?.initialSimSocPercent,
    });
    if (result.history_points_used < 2) {
      return null;
    }
    return {date, result};
  }
}
