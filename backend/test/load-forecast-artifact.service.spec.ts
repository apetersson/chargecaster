import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigDocument } from "../src/config/schemas";
import { LoadForecastArtifactService } from "../src/forecasting/load-forecast-artifact.service";

describe("LoadForecastArtifactService", () => {
  const originalModelDir = process.env.CHARGECASTER_LOAD_FORECAST_MODEL_DIR;
  const originalBundledDir = process.env.CHARGECASTER_BUNDLED_LOAD_FORECAST_DIR;

  afterEach(() => {
    if (originalModelDir === undefined) {
      delete process.env.CHARGECASTER_LOAD_FORECAST_MODEL_DIR;
    } else {
      process.env.CHARGECASTER_LOAD_FORECAST_MODEL_DIR = originalModelDir;
    }
    if (originalBundledDir === undefined) {
      delete process.env.CHARGECASTER_BUNDLED_LOAD_FORECAST_DIR;
    } else {
      process.env.CHARGECASTER_BUNDLED_LOAD_FORECAST_DIR = originalBundledDir;
    }
  });

  it("seeds the bundled starter model into an empty runtime model directory", () => {
    const runtimeBaseDir = mkdtempSync(join(tmpdir(), "chargecaster-load-runtime-"));
    const bundledBaseDir = mkdtempSync(join(tmpdir(), "chargecaster-load-bundled-"));
    const bundledCurrentDir = join(bundledBaseDir, "current");
    mkdirSync(bundledCurrentDir, { recursive: true });

    writeFileSync(join(bundledCurrentDir, "manifest.json"), JSON.stringify({
      model_type: "catboost",
      model_version: "starter-load-model",
      feature_schema_version: "v2_house_load_1",
      trained_at: "2026-03-20T00:00:00.000Z",
      training_window: { start: "2026-01-01T00:00:00.000Z", end: "2026-03-19T00:00:00.000Z" },
      history_row_count: 100,
      hourly_row_count: 100,
      metrics_summary: {
        mae: 100,
        rmse: 150,
        p50_absolute_error: 90,
        p90_absolute_error: 200,
      },
      catboost_version: "1.2.10",
    }));
    writeFileSync(join(bundledCurrentDir, "model.cbm"), "starter-model");
    writeFileSync(join(bundledCurrentDir, "metrics.json"), JSON.stringify({ model: { mae: 100 } }));
    writeFileSync(join(bundledCurrentDir, "training.log"), "seeded\n");

    process.env.CHARGECASTER_LOAD_FORECAST_MODEL_DIR = runtimeBaseDir;
    process.env.CHARGECASTER_BUNDLED_LOAD_FORECAST_DIR = bundledBaseDir;

    const service = new LoadForecastArtifactService();
    const config = { dry_run: true } as ConfigDocument;

    const artifact = service.readActiveArtifact(config);

    expect(artifact?.manifest.model_version).toBe("starter-load-model");
    expect(existsSync(join(runtimeBaseDir, "current", "model.cbm"))).toBe(true);
    expect(existsSync(join(runtimeBaseDir, "current", "manifest.json"))).toBe(true);

    rmSync(runtimeBaseDir, { recursive: true, force: true });
    rmSync(bundledBaseDir, { recursive: true, force: true });
  });
});
