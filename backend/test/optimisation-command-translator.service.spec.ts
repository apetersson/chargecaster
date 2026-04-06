import { describe, expect, it } from "vitest";
import { Percentage } from "@chargecaster/domain";

import { OptimisationCommandTranslator } from "../src/hardware/optimisation-command-translator.service";

describe("OptimisationCommandTranslator", () => {
  it("prefers auto for a live PV-assisted midday snapshot with only tiny immediate grid-charge energy", () => {
    const translator = new OptimisationCommandTranslator();

    const command = translator.fromSimulationSnapshot({
      current_mode: "charge",
      current_soc_percent: Percentage.fromPercent(16.5),
      next_step_soc_percent: Percentage.fromPercent(19),
      oracle_entries: [
        {
          era_id: "2026-03-31T09:36:05.418Z",
          start_soc_percent: 17,
          end_soc_percent: 19,
          target_soc_percent: 19,
          grid_energy_wh: 82.85645802062808,
          strategy: "charge",
        },
        {
          era_id: "2026-03-31T10:00:00.000Z",
          start_soc_percent: 19,
          end_soc_percent: 26,
          target_soc_percent: 26,
          grid_energy_wh: 79.38058793969822,
          strategy: "charge",
        },
        {
          era_id: "2026-03-31T11:00:00.000Z",
          start_soc_percent: 26,
          end_soc_percent: 38,
          target_soc_percent: 38,
          grid_energy_wh: 99.78315075376895,
          strategy: "charge",
        },
        {
          era_id: "2026-03-31T12:00:00.000Z",
          start_soc_percent: 38,
          end_soc_percent: 51,
          target_soc_percent: 51,
          grid_energy_wh: 0,
          strategy: "auto",
        },
        {
          era_id: "2026-03-31T13:00:00.000Z",
          start_soc_percent: 51,
          end_soc_percent: 88,
          target_soc_percent: 88,
          grid_energy_wh: 2374.4159648241202,
          strategy: "charge",
        },
      ],
      forecast_eras: [
        {
          era_id: "2026-03-31T09:36:05.418Z",
          start: "2026-03-31T09:36:05.418Z",
          end: "2026-03-31T10:00:00.000Z",
          duration_hours: 0.398495,
          sources: [],
        },
        {
          era_id: "2026-03-31T10:00:00.000Z",
          start: "2026-03-31T10:00:00.000Z",
          end: "2026-03-31T11:00:00.000Z",
          duration_hours: 1,
          sources: [],
        },
        {
          era_id: "2026-03-31T11:00:00.000Z",
          start: "2026-03-31T11:00:00.000Z",
          end: "2026-03-31T12:00:00.000Z",
          duration_hours: 1,
          sources: [],
        },
        {
          era_id: "2026-03-31T12:00:00.000Z",
          start: "2026-03-31T12:00:00.000Z",
          end: "2026-03-31T13:00:00.000Z",
          duration_hours: 1,
          sources: [],
        },
        {
          era_id: "2026-03-31T13:00:00.000Z",
          start: "2026-03-31T13:00:00.000Z",
          end: "2026-03-31T14:00:00.000Z",
          duration_hours: 1,
          sources: [],
        },
      ],
    } as never);

    expect(command).toEqual({
      auto: {
        floorSocPercent: 19,
      },
    });
  });

  it("prefers auto for a transient sunny-hour hold before PV-led charging resumes", () => {
    const translator = new OptimisationCommandTranslator();

    const command = translator.fromSimulationSnapshot({
      current_mode: "hold",
      current_soc_percent: Percentage.fromPercent(16.5),
      next_step_soc_percent: Percentage.fromPercent(17),
      oracle_entries: [
        {
          era_id: "2026-03-31T09:36:05.418Z",
          start_soc_percent: 17,
          end_soc_percent: 17,
          target_soc_percent: 17,
          grid_energy_wh: 0,
          strategy: "hold",
        },
        {
          era_id: "2026-03-31T10:00:00.000Z",
          start_soc_percent: 17,
          end_soc_percent: 24,
          target_soc_percent: 24,
          grid_energy_wh: 0,
          strategy: "auto",
        },
        {
          era_id: "2026-03-31T11:00:00.000Z",
          start_soc_percent: 24,
          end_soc_percent: 37,
          target_soc_percent: 37,
          grid_energy_wh: 0,
          strategy: "auto",
        },
        {
          era_id: "2026-03-31T13:00:00.000Z",
          start_soc_percent: 51,
          end_soc_percent: 88,
          target_soc_percent: 88,
          grid_energy_wh: 2374.4159648241202,
          strategy: "charge",
        },
      ],
      forecast_eras: [
        {
          era_id: "2026-03-31T09:36:05.418Z",
          start: "2026-03-31T09:36:05.418Z",
          end: "2026-03-31T10:00:00.000Z",
          duration_hours: 0.398495,
          sources: [],
        },
        {
          era_id: "2026-03-31T10:00:00.000Z",
          start: "2026-03-31T10:00:00.000Z",
          end: "2026-03-31T11:00:00.000Z",
          duration_hours: 1,
          sources: [],
        },
        {
          era_id: "2026-03-31T11:00:00.000Z",
          start: "2026-03-31T11:00:00.000Z",
          end: "2026-03-31T12:00:00.000Z",
          duration_hours: 1,
          sources: [],
        },
        {
          era_id: "2026-03-31T13:00:00.000Z",
          start: "2026-03-31T13:00:00.000Z",
          end: "2026-03-31T14:00:00.000Z",
          duration_hours: 1,
          sources: [],
        },
      ],
    } as never);

    expect(command).toEqual({
      auto: {
        floorSocPercent: 17,
      },
    });
  });

  it("derives the active charge horizon from consecutive charge eras", () => {
    const translator = new OptimisationCommandTranslator();

    const command = translator.fromSimulationSnapshot({
      current_mode: "charge",
      current_soc_percent: Percentage.fromPercent(42),
      next_step_soc_percent: Percentage.fromPercent(51),
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
        targetSocPercent: 51,
        minChargePowerW: null,
      },
    });
  });

  it("maps limit mode to a zero-charge cap with the planned floor", () => {
    const translator = new OptimisationCommandTranslator();

    const command = translator.fromSimulationSnapshot({
      current_mode: "limit",
      current_soc_percent: Percentage.fromPercent(42),
      next_step_soc_percent: Percentage.fromPercent(30),
      oracle_entries: [],
      forecast_eras: [],
    } as never);

    expect(command).toEqual({
      limit: {
        floorSocPercent: 30,
        maxChargePowerW: 0,
      },
    });
  });
});
