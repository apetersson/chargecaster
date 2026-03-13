import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ConfigDocument } from "../src/config/schemas";
import type { ConfigFileService } from "../src/config/config-file.service";
import { ModelTrainingCoordinator } from "../src/forecasting/model-training-coordinator.service";
import type { LoadForecastArtifactService } from "../src/forecasting/load-forecast-artifact.service";
import type { StorageService } from "../src/storage/storage.service";

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

function createConfig(): ConfigDocument {
  return {
    dry_run: true,
    load_forecast: {
      self_training_enabled: true,
      python_executable: "python3",
    },
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts background training when the local history and time window gates pass", async () => {
    vi.setSystemTime(new Date("2026-03-13T02:15:00.000+01:00"));
    const storage = {
      listHistoryDayStatsBefore: () => createDayStats(70),
    } as unknown as StorageService;
    const baseDir = mkdtempSync(join(tmpdir(), "chargecaster-models-"));
    const artifactService = {
      ensureBaseDir: () => baseDir,
      readActiveArtifact: () => null,
      promoteVersion: () => undefined,
      writePromotionMarker: () => undefined,
    } as unknown as LoadForecastArtifactService;
    const configFileService = {
      resolvePath: () => "/tmp/test-config.local.yaml",
    } as unknown as ConfigFileService;
    const service = new ModelTrainingCoordinator(storage, artifactService, configFileService);

    await service.maybeStartTraining(createConfig());

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe("python3");
    expect(spawnMock.mock.calls[0]?.[1]).toContain("/tmp/test-config.local.yaml");
  });

  it("does not start self-training outside the allowed time window", async () => {
    vi.setSystemTime(new Date("2026-03-13T12:15:00.000+01:00"));
    const storage = {
      listHistoryDayStatsBefore: () => createDayStats(70),
    } as unknown as StorageService;
    const artifactService = {
      ensureBaseDir: () => mkdtempSync(join(tmpdir(), "chargecaster-models-")),
      readActiveArtifact: () => null,
      promoteVersion: () => undefined,
      writePromotionMarker: () => undefined,
    } as unknown as LoadForecastArtifactService;
    const configFileService = {
      resolvePath: () => "/tmp/test-config.local.yaml",
    } as unknown as ConfigFileService;
    const service = new ModelTrainingCoordinator(storage, artifactService, configFileService);

    await service.maybeStartTraining(createConfig());

    expect(spawnMock).not.toHaveBeenCalled();
  });
});
