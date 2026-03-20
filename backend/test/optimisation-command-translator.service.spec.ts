import { describe, expect, it } from "vitest";

import { OptimisationCommandTranslator } from "../src/hardware/optimisation-command-translator.service";

describe("OptimisationCommandTranslator", () => {
  it("derives the active charge horizon from consecutive charge eras", () => {
    const translator = new OptimisationCommandTranslator();

    const command = translator.fromSimulationSnapshot({
      current_mode: "charge",
      current_soc_percent: 42,
      next_step_soc_percent: 51,
      oracle_entries: [
        {
          era_id: "era-1",
          start_soc_percent: 42,
          end_soc_percent: 46,
          target_soc_percent: 46,
          grid_energy_wh: 1000,
          strategy: "charge",
        },
        {
          era_id: "era-2",
          start_soc_percent: 46,
          end_soc_percent: 51,
          target_soc_percent: 51,
          grid_energy_wh: 1200,
          strategy: "charge",
        },
        {
          era_id: "era-3",
          start_soc_percent: 51,
          end_soc_percent: 51,
          target_soc_percent: 51,
          grid_energy_wh: 0,
          strategy: "auto",
        },
      ],
      forecast_eras: [
        {era_id: "era-1", start: "2026-03-20T19:00:00+01:00", end: "2026-03-20T20:00:00+01:00", duration_hours: 1, sources: []},
        {era_id: "era-2", start: "2026-03-20T20:00:00+01:00", end: "2026-03-20T21:00:00+01:00", duration_hours: 1, sources: []},
        {era_id: "era-3", start: "2026-03-20T21:00:00+01:00", end: "2026-03-20T22:00:00+01:00", duration_hours: 1, sources: []},
      ],
    } as never);

    expect(command).toEqual({
      charge: {
        untilTimestamp: "2026-03-20T21:00:00+01:00",
      },
    });
  });
});
