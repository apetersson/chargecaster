import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigDocument } from "../src/config/schemas";
import type { ConfigFileService } from "../src/config/config-file.service";
import { ModelTrainingCoordinator } from "../src/forecasting/model-training-coordinator.service";
import type { LoadForecastArtifactService } from "../src/forecasting/load-forecast-artifact.service";
import type { PriceForecastArtifactService } from "../src/forecasting/price-forecast-artifact.service";
import type { StorageService } from "../src/storage/storage.service";

const { spawnMock, spawnSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

function createConfig(): ConfigDocument {
  return {
    dry_run: true,
    forecast: ["load", "price"],
  };
}

function createDayStats(days: number) {
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(Date.UTC(2025, 11, 1 + index, 0, 0, 0, 0));
    const isoDate = date.toISOString().slice(0, 10);
    return {
      date: isoDate,
      firstTimestamp: `${isoDate}T00:00:00.000Z`,
      lastTimestamp: `${isoDate}T23:55:00.000Z`,
      pointCount: 288,
    };
  });
}

function createSpawnResult() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe("ModelTrainingCoordinator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    spawnMock.mockReturnValue(createSpawnResult());
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts load-forecast training when the local history and time window gates pass", () => {
    vi.setSystemTime(new Date("2026-03-13T02:15:00.000+01:00"));
    const storage = {
      listHistoryDayStatsBefore: () => createDayStats(70),
    } as unknown as StorageService;
    const loadBaseDir = mkdtempSync(join(tmpdir(), "chargecaster-load-models-"));
    const priceBaseDir = mkdtempSync(join(tmpdir(), "chargecaster-price-models-"));
    const loadArtifactService = {
      ensureBaseDir: () => loadBaseDir,
      readActiveArtifact: () => null,
      promoteVersion: () => undefined,
      writePromotionMarker: () => undefined,
    } as unknown as LoadForecastArtifactService;
    const priceArtifactService = {
      ensureBaseDir: () => priceBaseDir,
      readActiveArtifact: () => ({manifest: {training_window: {end: "2026-02-20T00:00:00.000Z"}}}),
      promoteVersion: () => undefined,
      writePromotionMarker: () => undefined,
    } as unknown as PriceForecastArtifactService;
    const configFileService = {
      resolvePath: () => "/tmp/test-config.local.yaml",
    } as unknown as ConfigFileService;
    const service = new ModelTrainingCoordinator(storage, loadArtifactService, priceArtifactService, configFileService);

    service.maybeStartTraining(createConfig());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe("python3");
    expect(spawnMock.mock.calls[0]?.[1]?.some((arg: unknown) => String(arg).includes("train_load_forecast.py"))).toBe(true);
    expect(spawnMock.mock.calls[0]?.[1]?.some((arg: unknown) => String(arg).includes("/tmp/test-config.local.yaml"))).toBe(true);
  });

  it("does not start scheduled retraining outside the allowed time window when models already exist", () => {
    vi.setSystemTime(new Date("2026-03-13T12:15:00.000+01:00"));
    const storage = {
      listHistoryDayStatsBefore: () => createDayStats(70),
    } as unknown as StorageService;
    const loadArtifactService = {
      ensureBaseDir: () => mkdtempSync(join(tmpdir(), "chargecaster-load-models-")),
      readActiveArtifact: () => ({manifest: {training_window: {end: "2026-03-10T00:00:00.000Z"}}}),
      promoteVersion: () => undefined,
      writePromotionMarker: () => undefined,
    } as unknown as LoadForecastArtifactService;
    const priceArtifactService = {
      ensureBaseDir: () => mkdtempSync(join(tmpdir(), "chargecaster-price-models-")),
      readActiveArtifact: () => ({manifest: {training_window: {end: "2026-03-10T00:00:00.000Z"}}}),
      promoteVersion: () => undefined,
      writePromotionMarker: () => undefined,
    } as unknown as PriceForecastArtifactService;
    const configFileService = {
      resolvePath: () => "/tmp/test-config.local.yaml",
    } as unknown as ConfigFileService;
    const service = new ModelTrainingCoordinator(storage, loadArtifactService, priceArtifactService, configFileService);

    service.maybeStartTraining(createConfig());

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("bootstraps missing models immediately on startup when any history exists", () => {
    vi.setSystemTime(new Date("2026-03-13T12:15:00.000+01:00"));
    const storage = {
      listHistoryDayStatsBefore: () => createDayStats(1),
    } as unknown as StorageService;
    const loadArtifactService = {
      ensureBaseDir: () => mkdtempSync(join(tmpdir(), "chargecaster-load-models-")),
      readActiveArtifact: () => null,
      promoteVersion: () => undefined,
      writePromotionMarker: () => undefined,
    } as unknown as LoadForecastArtifactService;
    const priceArtifactService = {
      ensureBaseDir: () => mkdtempSync(join(tmpdir(), "chargecaster-price-models-")),
      readActiveArtifact: () => null,
      promoteVersion: () => undefined,
      writePromotionMarker: () => undefined,
    } as unknown as PriceForecastArtifactService;
    const configFileService = {
      resolvePath: () => "/tmp/test-config.local.yaml",
    } as unknown as ConfigFileService;
    const service = new ModelTrainingCoordinator(storage, loadArtifactService, priceArtifactService, configFileService);

    service.maybeStartTraining(createConfig());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[1]?.some((arg: unknown) => String(arg).includes("train_load_forecast.py"))).toBe(true);
  });

  it("does not immediately retry a failed background training job", () => {
    vi.setSystemTime(new Date("2026-03-13T12:15:00.000+01:00"));
    const storage = {
      listHistoryDayStatsBefore: () => createDayStats(1),
    } as unknown as StorageService;
    const loadArtifactService = {
      ensureBaseDir: () => mkdtempSync(join(tmpdir(), "chargecaster-load-models-")),
      readActiveArtifact: () => null,
      promoteVersion: () => undefined,
      writePromotionMarker: () => undefined,
    } as unknown as LoadForecastArtifactService;
    const priceArtifactService = {
      ensureBaseDir: () => mkdtempSync(join(tmpdir(), "chargecaster-price-models-")),
      readActiveArtifact: () => null,
      promoteVersion: () => undefined,
      writePromotionMarker: () => undefined,
    } as unknown as PriceForecastArtifactService;
    const configFileService = {
      resolvePath: () => "/tmp/test-config.local.yaml",
    } as unknown as ConfigFileService;
    const service = new ModelTrainingCoordinator(storage, loadArtifactService, priceArtifactService, configFileService);

    service.maybeStartTraining(createConfig());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const firstChild = spawnMock.mock.results[0]?.value as ReturnType<typeof createSpawnResult>;
    firstChild.emit("exit", 1);

    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("does not start training when the local python is missing catboost", () => {
    vi.setSystemTime(new Date("2026-03-13T02:15:00.000+01:00"));
    spawnSyncMock.mockImplementation((command: unknown, args: unknown) => {
      if (command === "python3" && Array.isArray(args) && args[0] === "--version") {
        return { status: 0 };
      }
      if (command === "python3" && Array.isArray(args) && args[0] === "-c" && String(args[1]).includes("import catboost")) {
        return { status: 1 };
      }
      return { status: 0 };
    });
    const storage = {
      listHistoryDayStatsBefore: () => createDayStats(70),
    } as unknown as StorageService;
    const loadArtifactService = {
      ensureBaseDir: () => mkdtempSync(join(tmpdir(), "chargecaster-load-models-")),
      readActiveArtifact: () => null,
      promoteVersion: () => undefined,
      writePromotionMarker: () => undefined,
    } as unknown as LoadForecastArtifactService;
    const priceArtifactService = {
      ensureBaseDir: () => mkdtempSync(join(tmpdir(), "chargecaster-price-models-")),
      readActiveArtifact: () => null,
      promoteVersion: () => undefined,
      writePromotionMarker: () => undefined,
    } as unknown as PriceForecastArtifactService;
    const configFileService = {
      resolvePath: () => "/tmp/test-config.local.yaml",
    } as unknown as ConfigFileService;
    const service = new ModelTrainingCoordinator(storage, loadArtifactService, priceArtifactService, configFileService);

    service.maybeStartTraining(createConfig());

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("queues price-forecast training after bootstrapping load-forecast", () => {
    vi.setSystemTime(new Date("2026-03-13T12:15:00.000+01:00"));
    const storage = {
      listHistoryDayStatsBefore: () => createDayStats(1),
    } as unknown as StorageService;
    let loadReady = false;
    let priceReady = false;
    const loadArtifactService = {
      ensureBaseDir: () => mkdtempSync(join(tmpdir(), "chargecaster-load-models-")),
      readActiveArtifact: () => (loadReady ? {manifest: {training_window: {end: "2026-03-13T00:00:00.000Z"}}} : null),
      promoteVersion: () => {
        loadReady = true;
      },
      writePromotionMarker: () => undefined,
    } as unknown as LoadForecastArtifactService;
    const priceArtifactService = {
      ensureBaseDir: () => mkdtempSync(join(tmpdir(), "chargecaster-price-models-")),
      readActiveArtifact: () => (priceReady ? {manifest: {training_window: {end: "2026-03-13T00:00:00.000Z"}}} : null),
      promoteVersion: () => {
        priceReady = true;
      },
      writePromotionMarker: () => undefined,
    } as unknown as PriceForecastArtifactService;
    const configFileService = {
      resolvePath: () => "/tmp/test-config.local.yaml",
    } as unknown as ConfigFileService;
    const service = new ModelTrainingCoordinator(storage, loadArtifactService, priceArtifactService, configFileService);

    service.maybeStartTraining(createConfig());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[1]?.some((arg: unknown) => String(arg).includes("train_load_forecast.py"))).toBe(true);

    const firstVersionDir = String(spawnMock.mock.calls[0]?.[1]?.[6] ?? "");
    writeFileSync(join(firstVersionDir, "manifest.json"), JSON.stringify({
      model_type: "catboost",
      model_version: "test-load",
      feature_schema_version: "v2_house_load_1",
      trained_at: "2026-03-13T00:00:00.000Z",
      training_window: {start: "2026-03-01T00:00:00.000Z", end: "2026-03-13T00:00:00.000Z"},
      history_row_count: 1,
      hourly_row_count: 1,
      metrics_summary: {mae: 1, rmse: 1, p50_absolute_error: 1, p90_absolute_error: 1},
      catboost_version: "1.2.10",
    }));
    writeFileSync(join(firstVersionDir, "metrics.json"), JSON.stringify({
      model: {mae: 1, p90_economic_hours_absolute_error: 1},
      active_model: null,
    }));

    const firstChild = spawnMock.mock.results[0]?.value as ReturnType<typeof createSpawnResult>;
    firstChild.emit("exit", 0);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock.mock.calls[1]?.[1]?.some((arg: unknown) => String(arg).includes("train_price_forecast.py"))).toBe(true);
  });
});
