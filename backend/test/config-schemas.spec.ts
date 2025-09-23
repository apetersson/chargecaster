import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseEvccState, parseMarketForecast } from "../src/config/schemas";

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
});
