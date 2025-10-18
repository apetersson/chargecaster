import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normaliseSolarTimeseries,
  toSolarForecastSlots,
  type RawSolarTimeseriesPoint,
} from "@chargecaster/domain/solar-timeseries";

interface SolarForecastSource {
  provider: string;
  type: "solar";
  payload: {
    energy_wh: number;
    average_power_w?: number;
  };
}

interface CostForecastSource {
  provider: string;
  type: "cost";
  payload: Record<string, unknown>;
}

type ForecastSource = SolarForecastSource | CostForecastSource;

interface DashboardForecastEra {
  start: string;
  sources: ForecastSource[];
}

interface DashboardForecastFixture {
  result: {
    data: {
      eras: DashboardForecastEra[];
    };
  };
}

interface EvccForecastState {
  forecast: {
    solar: {
      timeseries: RawSolarTimeseriesPoint[];
    };
  };
}

interface SolarEraCandidate {
  start: string;
  solar: SolarForecastSource | null;
}

interface SolarEraMatch {
  start: string;
  solar: SolarForecastSource;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isSolarSource = (source: ForecastSource): source is SolarForecastSource =>
  source.type === "solar";

const isSolarEraMatch = (entry: SolarEraCandidate): entry is SolarEraMatch =>
  entry.solar !== null;

function assertIsDashboardForecastFixture(value: unknown): asserts value is DashboardForecastFixture {
  if (!isRecord(value)) {
    throw new Error("dashboard forecast fixture must be an object");
  }
  if (!isRecord(value.result)) {
    throw new Error("dashboard forecast fixture missing result");
  }
  const data = value.result.data;
  if (!isRecord(data)) {
    throw new Error("dashboard forecast fixture missing data");
  }
  const { eras } = data;
  if (!Array.isArray(eras)) {
    throw new Error("dashboard forecast fixture missing eras array");
  }
  for (const era of eras) {
    if (!isRecord(era)) {
      throw new Error("era entry must be an object");
    }
    if (typeof era.start !== "string") {
      throw new Error("era start must be a string");
    }
    if (!Array.isArray(era.sources)) {
      throw new Error("era sources must be an array");
    }
    for (const source of era.sources) {
      if (!isRecord(source)) {
        throw new Error("forecast source must be an object");
      }
      if (typeof source.provider !== "string") {
        throw new Error("forecast source provider must be a string");
      }
      if (source.type !== "solar" && source.type !== "cost") {
        throw new Error("forecast source type must be cost or solar");
      }
      if (!isRecord(source.payload)) {
        throw new Error("forecast source payload must be an object");
      }
      if (source.type === "solar" && typeof source.payload.energy_wh !== "number") {
        throw new Error("solar payload must include energy_wh");
      }
    }
  }
}

function assertIsEvccForecastState(value: unknown): asserts value is EvccForecastState {
  if (!isRecord(value)) {
    throw new Error("evcc state must be an object");
  }
  if (!isRecord(value.forecast)) {
    throw new Error("evcc state missing forecast");
  }
  const solar = value.forecast.solar;
  if (!isRecord(solar)) {
    throw new Error("evcc state missing solar forecast");
  }
  if (!Array.isArray(solar.timeseries)) {
    throw new Error("evcc solar timeseries must be an array");
  }
  for (const entry of solar.timeseries) {
    if (!isRecord(entry)) {
      throw new Error("evcc solar timeseries entries must be objects");
    }
  }
}

const oneHourSamples = [
  {ts: "2025-09-23T06:00:00Z", val: 193.744802},
  {ts: "2025-09-23T07:00:00Z", val: 298.309842},
  {ts: "2025-09-23T08:00:00Z", val: 487.5533288},
  {ts: "2025-09-23T09:00:00Z", val: 664.98054984},
  {ts: "2025-09-23T10:00:00Z", val: 0},
];

describe("solar timeseries normalisation", () => {
  it("converts watt samples into hourly energy", () => {
    const normalized = normaliseSolarTimeseries(oneHourSamples);
    expect(normalized).toHaveLength(4);
    const energies = normalized.map((item) => Number(item.energy.kilowattHours.toFixed(6)));
    expect(energies).toEqual([
      0.193745,
      0.29831,
      0.487553,
      0.664981,
    ]);
  });

  it("drops zero-length slots", () => {
    const samples = normaliseSolarTimeseries([
      {ts: "2025-09-23T06:00:00Z", val: 120},
      {ts: "2025-09-23T06:00:00Z", val: 120},
    ]);
    expect(samples).toHaveLength(1);
    const [entry] = samples;
    expect(entry.energy.kilowattHours).toBeGreaterThan(0);
    expect(entry.slot.duration.hours).toBeCloseTo(1, 6);
  });

  it("reuses previous slot duration when the final entry lacks an explicit end", () => {
    const samples = normaliseSolarTimeseries([
      {ts: "2025-09-24T15:45:00Z", val: 10},
      {ts: "2025-09-24T16:00:00Z", val: 20},
      {ts: "2025-09-24T16:15:00Z", val: 30.02215764},
    ]);

    expect(samples).toHaveLength(3);
    const durations = samples.map((sample) => sample.slot.duration.minutes);
    expect(durations).toEqual([15, 15, 15]);

    const last = samples[2];
    expect(last.energy.kilowattHours).toBeCloseTo(7.50553941, 6);
  });

  it("matches evcc solar timeseries energy with dashboard forecast payload", () => {
    const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
    const stateRaw: unknown = JSON.parse(readFileSync(join(fixtureDir, "evcc-state.json"), "utf-8"));
    assertIsEvccForecastState(stateRaw);
    const state = stateRaw;
    const forecastRaw: unknown = JSON.parse(readFileSync(join(fixtureDir, "dashboard-forecast.json"), "utf-8"));
    assertIsDashboardForecastFixture(forecastRaw);
    const forecast = forecastRaw;

    const normalizedSlots = toSolarForecastSlots(normaliseSolarTimeseries(state.forecast.solar.timeseries));
    const slotByStart = new Map(normalizedSlots.map((slot) => [slot.start, slot]));

    const solarEras = forecast.result.data.eras
      .map((era): SolarEraCandidate => ({
        start: era.start,
        solar: era.sources.find(isSolarSource) ?? null,
      }))
      .filter(isSolarEraMatch);

    expect(solarEras.length).toBeGreaterThan(0);

    for (const {start, solar} of solarEras) {
      const match = slotByStart.get(start);
      expect(match).toBeDefined();
      expect(match?.energy_wh).toBeCloseTo(solar.payload.energy_wh, 6);
    }

    const highEnergyEra = solarEras.find((entry) => entry.solar.payload.energy_wh > 10_000);
    expect(highEnergyEra?.solar.payload.energy_wh).toBeCloseTo(30_022.15764, 5);
    if (highEnergyEra) {
      const slot = slotByStart.get(highEnergyEra.start);
      expect(slot?.energy_wh).toBeCloseTo(highEnergyEra.solar.payload.energy_wh, 6);
    }
  });
});
