import { Inject, Injectable, Logger } from "@nestjs/common";
import { EnergyPrice, Money, Percentage, TariffSlot, parseTemporal } from "@chargecaster/domain";
import type { ForecastEra, SnapshotPayload, SnapshotSummary } from "@chargecaster/domain";
import { RuntimeConfigService } from "../config/runtime-config.service";
import { SimulationConfigFactory } from "../config/simulation-config.factory";
import { simulateOptimalSchedule } from "./optimal-schedule";

function isCostSource(
  source: ForecastEra["sources"][number],
): source is Extract<ForecastEra["sources"][number], { type: "cost" }> {
  return source.type === "cost";
}

function selectCostSource(
  era: ForecastEra,
): Extract<ForecastEra["sources"][number], { type: "cost" }> | null {
  const canonical = era.sources.find((source) => isCostSource(source) && source.provider === "canonical");
  if (canonical && canonical.type === "cost") {
    return canonical;
  }
  const fallback = era.sources.find(isCostSource);
  return fallback ?? null;
}

@Injectable()
export class SummaryService {
  private readonly logger = new Logger(SummaryService.name);

  constructor(
    @Inject(RuntimeConfigService) private readonly runtimeConfig: RuntimeConfigService,
    @Inject(SimulationConfigFactory) private readonly configFactory: SimulationConfigFactory,
  ) {
  }

  toSummary(snapshot: SnapshotPayload, options?: { previewHours?: number | null }): SnapshotSummary {
    this.logger.log(`Building summary for snapshot ${snapshot.timestamp}`);
    const snapshotPrice = typeof snapshot.price_snapshot_eur_per_kwh === "number"
      ? EnergyPrice.fromEurPerKwh(snapshot.price_snapshot_eur_per_kwh)
      : null;
    const previewSummary = this.buildPreviewSummary(snapshot, options?.previewHours ?? null);
    this.logger.verbose(
      `Summary pricing context: eur_per_kwh=${snapshot.price_snapshot_eur_per_kwh ?? "n/a"}, ct_per_kwh=${snapshotPrice?.ctPerKwh ?? "n/a"}`,
    );

    return {
      timestamp: snapshot.timestamp,
      interval_seconds: snapshot.interval_seconds,
      current_soc_percent: snapshot.current_soc_percent,
      next_step_soc_percent: snapshot.next_step_soc_percent,
      recommended_soc_percent: snapshot.recommended_soc_percent,
      recommended_final_soc_percent: snapshot.recommended_final_soc_percent,
      charge_efficiency_percent: snapshot.charge_efficiency_percent,
      discharge_efficiency_percent: snapshot.discharge_efficiency_percent,
      current_mode: snapshot.current_mode ?? undefined,
      price_snapshot_ct_per_kwh: snapshot.price_snapshot_ct_per_kwh ??
        (snapshotPrice ? snapshotPrice.ctPerKwh : null),
      price_snapshot_eur_per_kwh: snapshot.price_snapshot_eur_per_kwh,
      grid_fee_eur_per_kwh: snapshot.grid_fee_eur_per_kwh ?? null,
      projected_cost_eur: previewSummary?.projected_cost_eur ?? snapshot.projected_cost_eur,
      baseline_cost_eur: previewSummary?.baseline_cost_eur ?? snapshot.baseline_cost_eur,
      basic_battery_cost_eur: previewSummary?.basic_battery_cost_eur ?? snapshot.basic_battery_cost_eur,
      active_control_savings_eur: previewSummary?.active_control_savings_eur ?? snapshot.active_control_savings_eur,
      projected_savings_eur: previewSummary?.projected_savings_eur ?? snapshot.projected_savings_eur,
      projected_grid_power_w: previewSummary?.projected_grid_power_w ?? snapshot.projected_grid_power_w,
      expected_feed_in_kwh: previewSummary?.expected_feed_in_kwh ?? snapshot.expected_feed_in_kwh ?? null,
      expected_feed_in_profit_eur:
        previewSummary?.expected_feed_in_profit_eur ?? snapshot.expected_feed_in_profit_eur ?? null,
      solar_forecast_discrepancy_w: snapshot.solar_forecast_discrepancy_w,
      solar_forecast_discrepancy_start: snapshot.solar_forecast_discrepancy_start,
      solar_forecast_discrepancy_end: snapshot.solar_forecast_discrepancy_end,
      forecast_hours: previewSummary?.forecast_hours ?? snapshot.forecast_hours,
      forecast_samples: previewSummary?.forecast_samples ?? snapshot.forecast_samples,
      show_feed_in_price_bars: this.runtimeConfig.shouldShowFeedInPriceBars(),
      warnings: snapshot.warnings,
      errors: snapshot.errors,
    };
  }

  private buildPreviewSummary(
    snapshot: SnapshotPayload,
    previewHours: number | null,
  ): Pick<
    SnapshotSummary,
    | "projected_cost_eur"
    | "baseline_cost_eur"
    | "basic_battery_cost_eur"
    | "active_control_savings_eur"
    | "projected_savings_eur"
    | "projected_grid_power_w"
    | "expected_feed_in_kwh"
    | "expected_feed_in_profit_eur"
    | "forecast_hours"
    | "forecast_samples"
  > | null {
    if (typeof previewHours !== "number" || !Number.isFinite(previewHours) || previewHours <= 0) {
      return null;
    }

    const currentSoc = snapshot.current_soc_percent;
    if (typeof currentSoc !== "number" || !Number.isFinite(currentSoc)) {
      return null;
    }

    const rawRows = snapshot.forecast_eras
      .map((era) => {
        const start = parseTemporal(era.start);
        const end = parseTemporal(era.end);
        const costSource = selectCostSource(era);
        if (!start || !end || end.getTime() <= start.getTime() || !costSource) {
          return null;
        }
        const solarSource = era.sources.find((source) => source.type === "solar");
        return {
          eraId: era.era_id,
          start,
          end,
          priceEurPerKwh: Number(costSource.payload.price_eur_per_kwh),
          feedInTariffEurPerKwh: Number(costSource.payload.feed_in_tariff_eur_per_kwh ?? 0),
          solarGenerationKwh: Number(solarSource?.payload.energy_wh ?? 0) / 1000,
        };
      })
      .filter((row): row is NonNullable<typeof row> =>
        row !== null &&
        Number.isFinite(row.priceEurPerKwh) &&
        Number.isFinite(row.feedInTariffEurPerKwh) &&
        Number.isFinite(row.solarGenerationKwh),
      );

    if (rawRows.length === 0) {
      return null;
    }

    const anchorMs = parseTemporal(snapshot.timestamp)?.getTime() ?? Date.now();
    const cutoffMs = anchorMs + (previewHours * 3_600_000);
    let clippedRows = rawRows.filter((row) => row.start.getTime() < cutoffMs && row.end.getTime() > anchorMs);

    if (clippedRows.length === 0) {
      const fallbackAnchorMs = rawRows[0]?.start.getTime();
      if (typeof fallbackAnchorMs === "number" && Number.isFinite(fallbackAnchorMs)) {
        const fallbackCutoffMs = fallbackAnchorMs + (previewHours * 3_600_000);
        clippedRows = rawRows.filter((row) => row.start.getTime() < fallbackCutoffMs && row.end.getTime() > fallbackAnchorMs);
      }
    }

    if (clippedRows.length === 0) {
      return null;
    }

    const demandByStartMs = new Map<number, number>();
    for (const entry of snapshot.demand_forecast) {
      const start = parseTemporal(entry.start);
      if (!start) {
        continue;
      }
      demandByStartMs.set(start.getTime(), entry.house_power_w);
    }

    const config = this.configFactory.create(this.runtimeConfig.getDocumentRef());
    const slots = clippedRows.map((row) =>
      TariffSlot.fromDates(
        row.start,
        row.end,
        EnergyPrice.fromEurPerKwh(row.priceEurPerKwh),
        row.eraId,
      )
    );
    const sharedOptions = {
      solarGenerationKwhPerSlot: clippedRows.map((row) => row.solarGenerationKwh),
      houseLoadWattsPerSlot: clippedRows.map((row) => demandByStartMs.get(row.start.getTime())),
      feedInTariffEurPerKwhBySlot: clippedRows.map((row) => row.feedInTariffEurPerKwh),
      allowBatteryExport: config.logic.allow_battery_export ?? true,
      chargeEfficiency:
        typeof snapshot.charge_efficiency_percent === "number" && Number.isFinite(snapshot.charge_efficiency_percent)
          ? Percentage.fromPercent(snapshot.charge_efficiency_percent)
          : undefined,
      dischargeEfficiency:
        typeof snapshot.discharge_efficiency_percent === "number" && Number.isFinite(snapshot.discharge_efficiency_percent)
          ? Percentage.fromPercent(snapshot.discharge_efficiency_percent)
          : undefined,
    };
    const liveState = { battery_soc: currentSoc };
    const result = simulateOptimalSchedule(config, liveState, slots, sharedOptions);
    const autoResult = simulateOptimalSchedule(config, liveState, slots, {
      ...sharedOptions,
      allowGridChargeFromGrid: false,
    });

    return {
      projected_cost_eur: result.projected_cost_eur,
      baseline_cost_eur: result.baseline_cost_eur,
      basic_battery_cost_eur: autoResult.projected_cost_eur,
      active_control_savings_eur:
        Number.isFinite(autoResult.projected_cost_eur) && Number.isFinite(result.projected_cost_eur)
          ? Money.fromEur(autoResult.projected_cost_eur).subtract(Money.fromEur(result.projected_cost_eur)).eur
          : null,
      projected_savings_eur: result.projected_savings_eur,
      projected_grid_power_w: result.projected_grid_power_w,
      expected_feed_in_kwh: result.expected_feed_in_kwh,
      expected_feed_in_profit_eur: result.expected_feed_in_profit_eur,
      forecast_hours: result.forecast_hours,
      forecast_samples: result.forecast_samples,
    };
  }
}
