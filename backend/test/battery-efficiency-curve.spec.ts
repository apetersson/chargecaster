import { describe, expect, it } from "vitest";

import { Duration, Energy, Percentage } from "@chargecaster/domain";
import { resolveTransitionEfficiencies } from "../src/simulation/battery-efficiency-curve";

describe("resolveTransitionEfficiencies", () => {
  it("keeps fixed efficiencies for batteries without a chemistry curve", () => {
    const baseChargeEfficiency = Percentage.fromRatio(0.95);
    const baseDischargeEfficiency = Percentage.fromRatio(0.96);

    const result = resolveTransitionEfficiencies(
      null,
      Energy.fromKilowattHours(4),
      Duration.fromHours(1),
      Energy.fromKilowattHours(10),
      baseChargeEfficiency,
      baseDischargeEfficiency,
      0.25,
      0.25,
    );

    expect(result.chargeEfficiency.equals(baseChargeEfficiency)).toBe(true);
    expect(result.dischargeEfficiency.equals(baseDischargeEfficiency)).toBe(true);
  });

  it("uses the paper curve as a relative adjustment around the measured average C-rate", () => {
    const baseChargeEfficiency = Percentage.fromRatio(0.95);
    const baseDischargeEfficiency = Percentage.fromRatio(0.96);
    const capacity = Energy.fromKilowattHours(10);
    const duration = Duration.fromHours(1);
    const referenceCRate = 0.25;
    const referenceCharge = resolveTransitionEfficiencies(
      "lifepo4",
      Energy.fromKilowattHours(2.5),
      duration,
      capacity,
      baseChargeEfficiency,
      baseDischargeEfficiency,
      referenceCRate,
      referenceCRate,
    );

    const gentleCharge = resolveTransitionEfficiencies(
      "lifepo4",
      Energy.fromKilowattHours(1),
      duration,
      capacity,
      baseChargeEfficiency,
      baseDischargeEfficiency,
      referenceCRate,
      referenceCRate,
    );
    const fastCharge = resolveTransitionEfficiencies(
      "lifepo4",
      Energy.fromKilowattHours(4),
      duration,
      capacity,
      baseChargeEfficiency,
      baseDischargeEfficiency,
      referenceCRate,
      referenceCRate,
    );
    const fastDischarge = resolveTransitionEfficiencies(
      "lifepo4",
      Energy.fromKilowattHours(-4),
      duration,
      capacity,
      baseChargeEfficiency,
      baseDischargeEfficiency,
      referenceCRate,
      referenceCRate,
    );

    expect(referenceCharge.chargeEfficiency.ratio).toBeCloseTo(baseChargeEfficiency.ratio, 6);
    expect(gentleCharge.chargeEfficiency.ratio).toBeGreaterThan(baseChargeEfficiency.ratio);
    expect(fastCharge.chargeEfficiency.ratio).toBeLessThan(gentleCharge.chargeEfficiency.ratio);
    expect(fastCharge.chargeEfficiency.ratio).toBeCloseTo(0.941754, 6);
    expect(fastDischarge.dischargeEfficiency.ratio).toBeLessThan(baseDischargeEfficiency.ratio);
    expect(fastDischarge.dischargeEfficiency.ratio).toBeCloseTo(0.951225, 6);
  });
});
