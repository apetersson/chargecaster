import { Injectable } from "@nestjs/common";
import type { SnapshotPayload, SnapshotSummary } from "./types.js";

@Injectable()
export class SummaryService {
  toSummary(snapshot: SnapshotPayload): SnapshotSummary {
    return {
      timestamp: snapshot.timestamp,
      interval_seconds: snapshot.interval_seconds,
      house_load_w: snapshot.house_load_w,
      current_soc_percent: snapshot.current_soc_percent,
      next_step_soc_percent: snapshot.next_step_soc_percent,
      recommended_soc_percent: snapshot.recommended_soc_percent,
      recommended_final_soc_percent: snapshot.recommended_final_soc_percent,
      price_snapshot_ct_per_kwh: snapshot.price_snapshot_ct_per_kwh ??
        (typeof snapshot.price_snapshot_eur_per_kwh === "number"
          ? snapshot.price_snapshot_eur_per_kwh * 100
          : null),
      price_snapshot_eur_per_kwh: snapshot.price_snapshot_eur_per_kwh,
      projected_cost_eur: snapshot.projected_cost_eur,
      baseline_cost_eur: snapshot.baseline_cost_eur,
      projected_savings_eur: snapshot.projected_savings_eur,
      projected_grid_energy_w: snapshot.projected_grid_energy_w,
      forecast_hours: snapshot.forecast_hours,
      forecast_samples: snapshot.forecast_samples,
      warnings: snapshot.warnings ?? [],
      errors: snapshot.errors ?? [],
    };
  }
}
