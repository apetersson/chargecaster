import { beforeEach, describe, expect, it } from "vitest";

import { setRuntimeConfig, getRuntimeConfig } from "../src/config/runtime-config";
import { RuntimeConfigService } from "../src/config/runtime-config.service";

describe("RuntimeConfigService planning variant", () => {
  beforeEach(() => {
    setRuntimeConfig({
      dry_run: true,
      price: {
        dynamic: {
          awattar_sunny: {
            enabled: true,
          },
        },
      },
    });
  });

  it("defaults to awattar-sunny when no explicit feed-in variant is set", () => {
    const service = new RuntimeConfigService();

    expect(service.getPlanningVariant()).toBe("awattar-sunny");
  });

  it("persists an explicit awattar-sunny-spot runtime selection", () => {
    const service = new RuntimeConfigService();

    const updated = service.setPlanningVariant("awattar-sunny-spot");

    expect(updated.price?.feed_in?.type).toBe("awattar-sunny-spot");
    expect(service.getPlanningVariant()).toBe("awattar-sunny-spot");
    expect(getRuntimeConfig()?.price?.feed_in?.type).toBe("awattar-sunny-spot");
  });

  it("shows feed-in price bars for awattar-sunny while dry mode is enabled", () => {
    const service = new RuntimeConfigService();

    expect(service.shouldShowFeedInPriceBars()).toBe(true);
  });

  it("shows feed-in price bars for awattar-sunny-spot even outside dry mode", () => {
    setRuntimeConfig({
      dry_run: false,
      price: {
        feed_in: {
          type: "awattar-sunny-spot",
        },
      },
    });

    const service = new RuntimeConfigService();

    expect(service.shouldShowFeedInPriceBars()).toBe(true);
  });

  it("hides feed-in price bars for awattar-sunny outside dry mode", () => {
    setRuntimeConfig({
      dry_run: false,
      price: {
        feed_in: {
          type: "awattar-sunny",
        },
      },
    });

    const service = new RuntimeConfigService();

    expect(service.shouldShowFeedInPriceBars()).toBe(false);
  });
});
