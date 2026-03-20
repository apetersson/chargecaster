import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigDocument } from "../src/config/schemas";
import { ConfigHistoryService } from "../src/config/config-history.service";
import { SimulationConfigFactory } from "../src/config/simulation-config.factory";
import { StorageService } from "../src/storage/storage.service";

const baseConfig: ConfigDocument = {
  dry_run: true,
  battery: {
    capacity_kwh: 10,
    max_charge_power_w: 2000,
    auto_mode_floor_soc: 5,
  },
  logic: {
    interval_seconds: 300,
  },
};

describe("ConfigHistoryService", () => {
  afterEach(() => {
    delete process.env.CHARGECASTER_STORAGE_PATH;
  });

  it("records startup config only when it differs from the latest snapshot", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "chargecaster-config-history-"));
    const dbPath = join(tempDir, "backend.sqlite");
    process.env.CHARGECASTER_STORAGE_PATH = dbPath;

    const storage = new StorageService();
    const service = new ConfigHistoryService(storage, new SimulationConfigFactory());

    try {
      const first = service.recordStartupConfig(baseConfig, "2026-03-20T10:00:00.000Z");
      const repeated = service.recordStartupConfig(baseConfig, "2026-03-20T12:00:00.000Z");
      const changed = service.recordStartupConfig({
        ...baseConfig,
        battery: {
          ...baseConfig.battery,
          max_charge_power_w: 4000,
        },
      }, "2026-03-21T08:00:00.000Z");

      const snapshots = storage.listConfigSnapshotsAsc();

      expect(first.inserted).toBe(true);
      expect(repeated.inserted).toBe(false);
      expect(changed.inserted).toBe(true);
      expect(snapshots).toHaveLength(2);
      expect(snapshots[0]?.observedAt).toBe("2026-03-20T10:00:00.000Z");
      expect(snapshots[0]?.payload.battery?.max_charge_power_w).toBe(2000);
      expect(snapshots[1]?.payload.battery?.max_charge_power_w).toBe(4000);
      expect(snapshots[1]?.simulationConfig.battery.max_charge_power_w).toBe(4000);
      expect(storage.findConfigSnapshotForTimestamp("2026-03-20T18:00:00.000Z")?.payload.battery?.max_charge_power_w).toBe(2000);
      expect(storage.findConfigSnapshotForTimestamp("2026-03-21T12:00:00.000Z")?.payload.battery?.max_charge_power_w).toBe(4000);
    } finally {
      storage.onModuleDestroy();
      rmSync(tempDir, {recursive: true, force: true});
    }
  });
});
