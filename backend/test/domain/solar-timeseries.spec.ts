import { describe, expect, it } from "vitest";

import { normaliseSolarTimeseries } from "@batteryctl/domain";

const oneHourSamples = [
  { ts: "2025-09-23T06:00:00Z", val: 193.744802 },
  { ts: "2025-09-23T07:00:00Z", val: 298.309842 },
  { ts: "2025-09-23T08:00:00Z", val: 487.5533288 },
  { ts: "2025-09-23T09:00:00Z", val: 664.98054984 },
  { ts: "2025-09-23T10:00:00Z", val: 0 },
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
      { ts: "2025-09-23T06:00:00Z", val: 120 },
      { ts: "2025-09-23T06:00:00Z", val: 120 },
    ]);
    expect(samples).toHaveLength(1);
    const [entry] = samples;
    expect(entry.energy.kilowattHours).toBeGreaterThan(0);
    expect(entry.slot.duration.hours).toBeCloseTo(1, 6);
  });
});
