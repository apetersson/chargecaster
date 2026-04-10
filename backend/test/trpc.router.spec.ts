import { describe, expect, it, vi } from "vitest";

import { TrpcRouter } from "../src/trpc/trpc.router";

function createRouter({
  dryRunEnabled,
  variant = "awattar-sunny",
}: {
  dryRunEnabled: boolean;
  variant?: "awattar-sunny" | "awattar-sunny-spot";
}) {
  const runtimeConfig = {
    getPlanningVariant: vi.fn(() => variant),
    isDryRunEnabled: vi.fn(() => dryRunEnabled),
    shouldShowFeedInPriceBars: vi.fn(() => variant === "awattar-sunny-spot" || dryRunEnabled),
    setPlanningVariant: vi.fn(),
  };
  const simulationSeedService = {
    seedFromConfig: vi.fn().mockResolvedValue(undefined),
  };

  const router = new TrpcRouter(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    runtimeConfig as never,
    {} as never,
    simulationSeedService as never,
    { getContext: vi.fn(() => ({ backend_build_version: "test-build" })) } as never,
  );

  return {
    caller: router.router.createCaller({}),
    runtimeConfig,
    simulationSeedService,
  };
}

describe("TrpcRouter planning variant", () => {
  it("exposes the feed-in price bar flag through the summary response", async () => {
    const { caller } = createRouter({
      dryRunEnabled: false,
      variant: "awattar-sunny-spot",
    });
    const summaryPayload = {
      timestamp: "2026-03-23T17:00:00.000Z",
      interval_seconds: 300,
      current_soc_percent: 40,
      next_step_soc_percent: 42,
      recommended_soc_percent: 42,
      recommended_final_soc_percent: 55,
      charge_efficiency_percent: 95,
      discharge_efficiency_percent: 94,
      current_mode: "auto",
      price_snapshot_ct_per_kwh: 20,
      price_snapshot_eur_per_kwh: 0.2,
      grid_fee_eur_per_kwh: 0.09,
      projected_cost_eur: 1,
      baseline_cost_eur: 2,
      basic_battery_cost_eur: 1.5,
      active_control_savings_eur: 0.5,
      projected_savings_eur: 1,
      projected_grid_power_w: 300,
      expected_feed_in_kwh: 2,
      expected_feed_in_profit_eur: 0.5,
      solar_forecast_discrepancy_w: 0,
      solar_forecast_discrepancy_start: undefined,
      solar_forecast_discrepancy_end: undefined,
      forecast_hours: 24,
      forecast_samples: 24,
      forecast_eras: [],
      demand_forecast: [],
      oracle_entries: [],
      history: [],
      warnings: [],
      errors: [],
    };
    const summaryService = {
      toSummary: vi.fn(() => ({
        ...summaryPayload,
        show_feed_in_price_bars: true,
      })),
    };
    const router = new TrpcRouter(
      { ensureSeedFromFixture: vi.fn(() => summaryPayload) } as never,
      {} as never,
      {} as never,
      summaryService as never,
      {} as never,
      {} as never,
      {
        getPlanningVariant: vi.fn(() => "awattar-sunny-spot"),
        isDryRunEnabled: vi.fn(() => false),
        shouldShowFeedInPriceBars: vi.fn(() => true),
        setPlanningVariant: vi.fn(),
      } as never,
      {} as never,
      { seedFromConfig: vi.fn() } as never,
      { getContext: vi.fn(() => ({ backend_build_version: "test-build" })) } as never,
    );

    const result = await router.router.createCaller({}).dashboard.summary();

    expect(result.show_feed_in_price_bars).toBe(true);
  });

  it("allows switching the planning variant while dry mode is enabled", async () => {
    const { caller, runtimeConfig, simulationSeedService } = createRouter({
      dryRunEnabled: true,
      variant: "awattar-sunny-spot",
    });

    const result = await caller.dashboard.setPlanningVariant({
      variant: "awattar-sunny-spot",
    });

    expect(runtimeConfig.setPlanningVariant).toHaveBeenCalledWith("awattar-sunny-spot");
    expect(simulationSeedService.seedFromConfig).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      variant: "awattar-sunny-spot",
      dryRunEnabled: true,
    });
  });

  it("rejects switching the planning variant while dry mode is disabled", async () => {
    const { caller, runtimeConfig, simulationSeedService } = createRouter({
      dryRunEnabled: false,
    });

    await expect(
      caller.dashboard.setPlanningVariant({
        variant: "awattar-sunny-spot",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Planning variant switching is only available in dry mode.",
    });

    expect(runtimeConfig.setPlanningVariant).not.toHaveBeenCalled();
    expect(simulationSeedService.seedFromConfig).not.toHaveBeenCalled();
  });

  it("exposes system context through a dedicated dashboard procedure", async () => {
    const systemContext = {
      backend_build_version: "build-123",
      load_forecast: {
        method: "catboost_model",
        active_source: "runtime_current",
        model_version: "load-v3",
        feature_schema_version: "v3_house_load_forward_features_1",
        trained_at: "2026-04-10T10:00:00.000Z",
        training_window_end: "2026-04-09T23:00:00.000Z",
        runtime_status: "serving",
        last_promotion_decision: "promoted",
        training_active: false,
        last_training_attempt_at: "2026-04-10T10:05:00.000Z",
        last_training_result: "promoted",
        last_training_message: "Promoted load-v3",
      },
      price_forecast: {
        method: "catboost_model",
        model_version: "price-v1",
        feature_schema_version: "v1",
        trained_at: "2026-04-10T09:00:00.000Z",
        training_window_end: "2026-04-09T23:00:00.000Z",
        training_active: false,
        last_training_attempt_at: null,
        last_training_result: null,
        last_training_message: null,
      },
    };
    const router = new TrpcRouter(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        getPlanningVariant: vi.fn(() => "awattar-sunny"),
        isDryRunEnabled: vi.fn(() => true),
        shouldShowFeedInPriceBars: vi.fn(() => false),
        setPlanningVariant: vi.fn(),
      } as never,
      {} as never,
      { seedFromConfig: vi.fn() } as never,
      { getContext: vi.fn(() => systemContext) } as never,
    );

    const result = await router.router.createCaller({}).dashboard.systemContext();

    expect(result).toEqual(systemContext);
  });
});
