import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { MarketDataService } from "../src/config/market-data.service";
import type { SimulationConfig } from "../src/simulation/types";

const fixturePath = join(process.cwd(), "fixtures", "awattar-market-sample.json");

const loadFixture = () => JSON.parse(readFileSync(fixturePath, "utf-8")) as unknown;

type FetchResult = Awaited<ReturnType<typeof global.fetch>>;

const createResponse = (body: unknown): FetchResult => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(body),
}) as FetchResult;

describe("MarketDataService", () => {
  const service = new MarketDataService();
  const simulationConfig: SimulationConfig = {
    battery: {
      capacity_kwh: 10,
      max_charge_power_w: 3000,
    },
    price: {
      grid_fee_eur_per_kwh: 0.02,
    },
    logic: {
      interval_seconds: 300,
      min_hold_minutes: 10,
      house_load_w: 1200,
      allow_battery_export: true,
    },
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("collects market entries and derives a snapshot", async () => {
    const fixture = loadFixture() as {
      data?: { start_timestamp?: number; end_timestamp?: number; start?: string; end?: string }[];
    };
    const now = Date.now();
    fixture.data = fixture.data?.map((entry, index) => {
      const startTs = now + index * 3_600_000;
      const endTs = startTs + 3_600_000;
      return {
        ...entry,
        start_timestamp: startTs,
        end_timestamp: endTs,
        start: new Date(startTs).toISOString(),
        end: new Date(endTs).toISOString(),
      };
    });
    vi.spyOn(global, "fetch").mockResolvedValueOnce(createResponse(fixture));
    const warnings: string[] = [];

    const result = await service.collect({enabled: true, prefer_market: true}, simulationConfig, warnings);

    expect(result.forecast.length).toBeGreaterThan(0);
    expect(result.priceSnapshot).not.toBeNull();
    expect(warnings).not.toContain("Market data fetch disabled in config.");
  });

  it("returns empty set when disabled", async () => {
    const warnings: string[] = [];
    const result = await service.collect({enabled: false, prefer_market: true}, simulationConfig, warnings);

    expect(result.forecast).toHaveLength(0);
    expect(result.priceSnapshot).toBeNull();
    expect(warnings).toContain("Market data fetch disabled in config.");
  });
});
