import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseConfigDocument, parseEvccState, parseMarketForecast } from "../src/config/schemas";

const fixturePath = (name: string) => join(process.cwd(), "fixtures", name);

describe("configuration schema parsers", () => {
  it("parses awattar market data sample", () => {
    const raw = JSON.parse(readFileSync(fixturePath("awattar-market-sample.json"), "utf-8")) as unknown;
    const parsed = parseMarketForecast(raw);

    expect(parsed).toHaveLength(2);
    expect(new Date(parsed[0]?.start ?? "").toISOString()).toBe("2025-09-23T00:00:00.000Z");
    expect(parsed[0]?.price).toBe(12.34);
    expect(parsed[1]?.price_with_fee_ct_per_kwh).toBe(13.12);
  });

  it("parses EVCC state sample", () => {
    const raw = JSON.parse(readFileSync(fixturePath("evcc-state-sample.json"), "utf-8")) as unknown;
    const parsed = parseEvccState(raw);

    expect(parsed.forecast.length).toBeGreaterThan(0);
    expect(parsed.solarTimeseries.length).toBe(2);
    expect(parsed.batterySoc).toBeCloseTo(84.5, 3);
    expect(parsed.gridPowerW).toBeCloseTo(-320.1, 3);
    expect(parsed.solarPowerW).toBeCloseTo(450, 3);
    expect(parsed.priceSnapshot).toBeCloseTo(0.32, 5);
  });

  it("deduplicates overlapping EVCC forecast arrays", () => {
    const raw = JSON.parse(readFileSync(join(process.cwd(), "test", "fixtures", "evcc-state.json"), "utf-8")) as unknown;
    const parsed = parseEvccState(raw);

    expect(parsed.forecast).toHaveLength(21);
    expect(new Set(parsed.forecast.map((entry) => `${entry.start}|${entry.end}|${entry.value ?? entry.price}`)).size).toBe(21);
  });

  it("derives EV charge and total site demand from loadpoints", () => {
    const raw = JSON.parse(readFileSync(fixturePath("solar-confusion.json"), "utf-8")) as unknown;
    const parsed = parseEvccState(raw);

    expect(parsed.homePowerW).toBeCloseTo(1292.276, 3);
    expect(parsed.evChargePowerW).toBeCloseTo(10984.894, 3);
    expect(parsed.siteDemandPowerW).toBeCloseTo(12277.17, 2);
  });

  it("accepts location config and rejects retired direct-use config", () => {
    const parsed = parseConfigDocument({
      location: {
        latitude: 48.235,
        longitude: 16.134,
      },
      logic: {
        interval_seconds: 300,
        house_load_w: 2200,
      },
    });

    expect(parsed.location?.latitude).toBe(48.235);
    expect(parsed.location?.longitude).toBe(16.134);
    expect(parsed.logic?.interval_seconds).toBe(300);
    expect("house_load_w" in (parsed.logic ?? {})).toBe(false);
    expect(() => parseConfigDocument({ solar: { direct_use_ratio: 0.6 } })).toThrow();
  });
});
