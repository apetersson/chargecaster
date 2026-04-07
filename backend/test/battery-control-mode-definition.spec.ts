import { describe, expect, it } from "vitest";

import {
  createHoldModeDefinition,
  createLimitModeDefinition,
  type BatteryControlSlotScenario,
} from "../src/hardware/battery-control-backend";

function buildScenario(overrides: Partial<BatteryControlSlotScenario> = {}): BatteryControlSlotScenario {
  return {
    startSocPercent: 20,
    startSocStep: 20,
    socPercentStep: 1,
    energyPerStepWh: 100,
    capacityWh: 10_000,
    minAllowedSocPercent: 5,
    minAllowedSoCStep: 5,
    maxAllowedSocPercent: 100,
    maxAllowedSoCStep: 100,
    durationHours: 1,
    chemistry: null,
    chargeEfficiencyRatio: 1,
    dischargeEfficiencyRatio: 1,
    chargeAverageCRate: 0.5,
    dischargeAverageCRate: 0.5,
    loadAfterDirectUseWh: 0,
    availableSolarWh: 2_500,
    baselineGridEnergyWh: -2_500,
    baselineGridImportWh: 0,
    gridChargeLimitWh: 4_000,
    solarChargeLimitWh: 4_000,
    totalChargeLimitWh: 4_000,
    dischargeLimitWh: 4_000,
    allowBatteryExport: true,
    ...overrides,
  };
}

describe("battery control mode definitions", () => {
  it("treats hold as a discharge floor instead of a fixed SoC target", () => {
    const hold = createHoldModeDefinition({
      floorSocRange: {minPercent: 0, maxPercent: 100, stepPercent: 1},
      targetSocRange: {minPercent: 0, maxPercent: 100, stepPercent: 1},
    });

    const outcome = hold.applySlotScenario(buildScenario(), {
      targetSocPercent: 20,
      floorSocPercent: 20,
    });

    expect(outcome).not.toBeNull();
    expect(outcome?.mode).toBe("hold");
    expect(outcome?.endSocPercent).toBeGreaterThan(20);
  });

  it("treats limit as a charge ceiling during solar surplus", () => {
    const limit = createLimitModeDefinition({
      floorSocRange: {minPercent: 0, maxPercent: 100, stepPercent: 1},
      maxChargePowerRange: {
        minPowerW: 0,
        maxPowerW: 4_000,
        stepPowerW: 1,
        supportsZeroPower: true,
        supportsWindows: true,
      },
    });

    const outcome = limit.applySlotScenario(buildScenario(), {
      floorSocPercent: 20,
      maxChargePowerW: 0,
    });

    expect(outcome).not.toBeNull();
    expect(outcome?.mode).toBe("limit");
    expect(outcome?.endSocPercent).toBe(20);
  });

  it("still allows limit to discharge below its ceiling when the site needs energy", () => {
    const limit = createLimitModeDefinition({
      floorSocRange: {minPercent: 0, maxPercent: 100, stepPercent: 1},
      maxChargePowerRange: {
        minPowerW: 0,
        maxPowerW: 4_000,
        stepPowerW: 1,
        supportsZeroPower: true,
        supportsWindows: true,
      },
    });

    const outcome = limit.applySlotScenario(buildScenario({
      startSocPercent: 57,
      startSocStep: 57,
      loadAfterDirectUseWh: 1_200,
      availableSolarWh: 0,
      baselineGridEnergyWh: 1_200,
      baselineGridImportWh: 1_200,
    }), {
      floorSocPercent: 57,
      maxChargePowerW: 0,
    });

    expect(outcome).not.toBeNull();
    expect(outcome?.mode).toBe("limit");
    expect(outcome?.endSocPercent).toBeLessThan(57);
  });
});
