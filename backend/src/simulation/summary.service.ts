import { Injectable, Logger } from "@nestjs/common";
import { EnergyPrice } from "@chargecaster/domain";
import type { SnapshotPayload, SnapshotSummary } from "@chargecaster/domain";

@Injectable()
export class SummaryService {
  private readonly logger = new Logger(SummaryService.name);

  toSummary(snapshot: SnapshotPayload): SnapshotSummary {
    this.logger.log(`Building summary for snapshot ${snapshot.timestamp}`);
    const snapshotPrice = typeof snapshot.price_snapshot_eur_per_kwh === "number"
      ? EnergyPrice.fromEurPerKwh(snapshot.price_snapshot_eur_per_kwh)
      : null;
    this.logger.verbose(
      `Summary pricing context: eur_per_kwh=${snapshot.price_snapshot_eur_per_kwh ?? "n/a"}, ct_per_kwh=${snapshotPrice?.ctPerKwh ?? "n/a"}`,
    );

    return {
      timestamp: snapshot.timestamp,
      interval_seconds: snapshot.interval_seconds,
      house_load_w: snapshot.house_load_w,
      solar_direct_use_ratio: snapshot.solar_direct_use_ratio ?? null,
      current_soc_percent: snapshot.current_soc_percent,
      next_step_soc_percent: snapshot.next_step_soc_percent,
      recommended_soc_percent: snapshot.recommended_soc_percent,
      recommended_final_soc_percent: snapshot.recommended_final_soc_percent,
      current_mode: snapshot.current_mode ?? undefined,
      price_snapshot_ct_per_kwh: snapshot.price_snapshot_ct_per_kwh ??
        (snapshotPrice ? snapshotPrice.ctPerKwh : null),
      price_snapshot_eur_per_kwh: snapshot.price_snapshot_eur_per_kwh,
      projected_cost_eur: snapshot.projected_cost_eur,
      baseline_cost_eur: snapshot.baseline_cost_eur,
      basic_battery_cost_eur: snapshot.basic_battery_cost_eur,
      active_control_savings_eur: snapshot.active_control_savings_eur,
      backtested_savings_eur: snapshot.backtested_savings_eur,
      projected_savings_eur: snapshot.projected_savings_eur,
      projected_grid_power_w: snapshot.projected_grid_power_w,
      forecast_hours: snapshot.forecast_hours,
      forecast_samples: snapshot.forecast_samples,
      warnings: snapshot.warnings ?? [],
      errors: snapshot.errors ?? [],
    };
  }
}
