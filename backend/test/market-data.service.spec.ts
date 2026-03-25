import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SimulationConfig } from "@chargecaster/domain";
import { MarketDataService } from "../src/config/market-data.service";

const fixturePath = join(process.cwd(), "fixtures", "awattar-market-sample.json");

const loadFixture = () => JSON.parse(readFileSync(fixturePath, "utf-8")) as unknown;

type FetchResult = Awaited<ReturnType<typeof global.fetch>>;

const createResponse = (body: unknown): FetchResult => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(body),
}) as FetchResult;

const createAwattarEntry = (startIso: string, priceEurPerKwh: number) => {
  const startMs = new Date(startIso).getTime();
  return {
    start_timestamp: startMs,
    end_timestamp: startMs + 3_600_000,
    marketprice: priceEurPerKwh,
    unit: "EUR/kWh",
  };
};

const createEntsoeResponse = (startIso: string, pricesEurPerKwh: number[]) => {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + pricesEurPerKwh.length * 3_600_000);
  return {
    instanceList: [
      {
        curveData: {
          periodList: [
            {
              timeInterval: {
                from: start.toISOString(),
                to: end.toISOString(),
              },
              resolution: "PT1H",
              pointMap: Object.fromEntries(
                pricesEurPerKwh.map((price, index) => [String(index), [String(price * 1000)]]),
              ),
            },
          ],
        },
      },
    ],
  };
};

describe("MarketDataService", () => {
  const service = new MarketDataService({} as never, {} as never);
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
      allow_battery_export: true,
    },
  };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("collects market entries and derives a snapshot", async () => {
    vi.setSystemTime(new Date("2026-03-23T09:00:00.000Z"));
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

    const result = await service.collect({awattar: {priority: 1, url: "https://api.awattar.de/v1/marketdata"}}, simulationConfig, warnings);

    expect(result.forecast.length).toBeGreaterThan(0);
    expect(result.priceSnapshot).not.toBeNull();
    expect(warnings).not.toContain("Market data fetch disabled in config.");
  });

  it("blends providers by overlaying higher-priority windows onto lower-priority coverage", async () => {
    vi.setSystemTime(new Date("2026-03-23T09:00:00.000Z"));

    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(createResponse({
        data: [
          createAwattarEntry("2026-03-23T10:00:00.000Z", 0.2),
          createAwattarEntry("2026-03-23T11:00:00.000Z", 0.21),
        ],
      }))
      .mockResolvedValueOnce(createResponse(
        createEntsoeResponse("2026-03-23T09:00:00.000Z", [0.1, 0.11, 0.12, 0.13, 0.14]),
      ))
      .mockResolvedValueOnce(createResponse(
        createEntsoeResponse("2026-03-24T00:00:00.000Z", []),
      ));

    const warnings: string[] = [];
    const evccFallback = [
      {
        start: "2026-03-23T12:00:00.000Z",
        end: "2026-03-23T13:00:00.000Z",
        price: 0.3,
        unit: "EUR/kWh",
      },
      {
        start: "2026-03-23T13:00:00.000Z",
        end: "2026-03-23T14:00:00.000Z",
        price: 0.31,
        unit: "EUR/kWh",
      },
    ];

    const result = await service.collect({
      awattar: {priority: 2, url: "https://api.awattar.de/v1/marketdata", max_hours: 72},
      from_evcc: {priority: 3},
      entsoe: {priority: 4, zone: "BZN|10YAT-APG------L", tz: "CET", max_hours: 24, aggregate_hourly: false},
    }, simulationConfig, warnings, evccFallback);

    expect(result.forecast.map((entry) => ({
      start: entry.start,
      price: entry.price,
      provider: entry.provider,
    }))).toEqual([
      {start: "2026-03-23T09:00:00.000Z", price: 0.1, provider: "entsoe"},
      {start: "2026-03-23T10:00:00.000Z", price: 0.2, provider: "awattar"},
      {start: "2026-03-23T11:00:00.000Z", price: 0.21, provider: "awattar"},
      {start: "2026-03-23T12:00:00.000Z", price: 0.3, provider: "from_evcc"},
      {start: "2026-03-23T13:00:00.000Z", price: 0.31, provider: "from_evcc"},
    ]);
    expect(result.priceSnapshot).toBeCloseTo(0.12, 6);
    expect(warnings).toEqual([]);
  });

  it("returns empty set when no providers are configured", async () => {
    const warnings: string[] = [];
    const result = await service.collect({}, simulationConfig, warnings);

    expect(result.forecast).toHaveLength(0);
    expect(result.priceSnapshot).toBeNull();
    expect(warnings.length === 0 || warnings.includes("Awattar response contained no usable price slots.")).toBe(true);
  });
});
