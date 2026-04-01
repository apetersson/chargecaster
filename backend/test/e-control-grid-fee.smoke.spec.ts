import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ConfigDocument } from "../src/config/schemas";
import { DynamicPriceConfigService } from "../src/config/dynamic-price-config.service";
import { AwattarSunnyFeedInPriceProvider } from "../src/config/price-providers/awattar-sunny-feed-in-price.provider";
import { AwattarSunnySpotFeedInPriceProvider } from "../src/config/price-providers/awattar-sunny-spot-feed-in-price.provider";
import { EControlGridFeePriceProvider } from "../src/config/price-providers/e-control-grid-fee-price.provider";
import { StorageService } from "../src/storage/storage.service";

describe("E-Control grid fee smoke", () => {
  let tempDir: string | null = null;
  let storage: StorageService | null = null;

  afterEach(() => {
    if (storage) {
      storage.onModuleDestroy();
      storage = null;
    }
    if (tempDir) {
      rmSync(tempDir, {recursive: true, force: true});
      tempDir = null;
    }
    delete process.env.CHARGECASTER_STORAGE_PATH;
  });

  it("reads the official 2026 Wien values and sees SNAP reduce the midday fee", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "chargecaster-econtrol-smoke-"));
    process.env.CHARGECASTER_STORAGE_PATH = join(tempDir, "backend.sqlite");
    storage = new StorageService();
    const service = new DynamicPriceConfigService(
      storage,
      new EControlGridFeePriceProvider(),
      new AwattarSunnyFeedInPriceProvider(),
      new AwattarSunnySpotFeedInPriceProvider(),
    );
    const config: ConfigDocument = {
      dry_run: true,
      price: {
        grid_fee: {
          type: "e-control",
          netzbereich: "Wien",
        },
      },
      location: {
        timezone: "Europe/Vienna",
      },
    };

    const applied = await service.refreshAndApply(config, new Date("2026-04-08T10:00:00.000Z"));
    const records = storage.listDynamicPriceRecords();
    const record = records.find((entry) => entry.priceKey === "grid_fee_eur_per_kwh" && entry.source === "e-control");

    expect(applied.price?.grid_fee_eur_per_kwh).toBeCloseTo(0.077424, 6);
    expect(record?.metadata).toEqual(
      expect.objectContaining({
        netzbereich: "Wien",
        snap: expect.objectContaining({
          enabled: true,
          start_day: 1,
          start_month: 4,
          end_day: 30,
          end_month: 9,
          start_hour: 10,
          end_hour: 16,
        }),
        components: expect.objectContaining({
          netznutzungsentgelt_ap_cent_per_kwh: expect.closeTo(6.98, 2),
          netznutzungsentgelt_snap_ap_cent_per_kwh: expect.closeTo(5.58, 2),
          erneuerbaren_foerderbeitrag_arbeit_cent_per_kwh: expect.closeTo(0.035, 3),
          total_gross_cent_per_kwh: expect.closeTo(9.4224, 4),
          total_gross_snap_cent_per_kwh: expect.closeTo(7.7424, 4),
        }),
      }),
    );
  }, 30_000);
});
