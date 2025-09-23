import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { EvccDataService } from "../src/config/evcc-data.service";

const fixturePath = join(process.cwd(), "fixtures", "evcc-state-sample.json");

const loadFixture = () => JSON.parse(readFileSync(fixturePath, "utf-8")) as unknown;

type FetchResult = Awaited<ReturnType<typeof global.fetch>>;

const createResponse = (body: unknown): FetchResult => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(body),
}) as FetchResult;

describe("EvccDataService", () => {
  const service = new EvccDataService();

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses EVCC state into forecast artefacts", async () => {
    const payload = loadFixture();
    vi.spyOn(global, "fetch").mockResolvedValueOnce(createResponse(payload) as unknown as FetchResult);

    const warnings: string[] = [];
    const result = await service.collect({enabled: true, base_url: "http://example.com"}, warnings);

    expect(warnings).toHaveLength(0);
    expect(result.forecast.length).toBeGreaterThan(0);
    expect(result.solarForecast.length).toBeGreaterThan(0);
    expect(result.priceSnapshot).not.toBeNull();
    expect(typeof result.batterySoc).toBe("number");
  });

  it("returns empty result when EVCC is disabled", async () => {
    const warnings: string[] = [];
    const result = await service.collect({enabled: false}, warnings);

    expect(result.forecast).toHaveLength(0);
    expect(result.solarForecast).toHaveLength(0);
    expect(result.priceSnapshot).toBeNull();
    expect(warnings).toContain("EVCC data fetch disabled in config.");
  });

  it("warns when base URL is missing", async () => {
    const warnings: string[] = [];
    const result = await service.collect({enabled: true}, warnings);

    expect(result.forecast).toHaveLength(0);
    expect(warnings).toContain("EVCC base_url not configured; skipping EVCC forecast.");
  });
});
