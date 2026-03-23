import { describe, expect, it } from "vitest";

import { computeGridEnergyCost, Duration, Energy, EnergyPrice, Money } from "@chargecaster/domain";

describe("Money", () => {
  it("supports signed arithmetic and serialization", () => {
    const importCost = Money.fromEur(4.25);
    const exportCredit = Money.fromEur(-1.1);

    expect(importCost.add(exportCredit).eur).toBeCloseTo(3.15, 9);
    expect(importCost.subtract(exportCredit).eur).toBeCloseTo(5.35, 9);
    expect(exportCredit.negate().eur).toBeCloseTo(1.1, 9);
    expect(exportCredit.abs().eur).toBeCloseTo(1.1, 9);
    expect(importCost.multiply(2).eur).toBeCloseTo(8.5, 9);
    expect(JSON.stringify(importCost)).toBe("4.25");
  });

  it("prices import and export energy via EnergyPrice", () => {
    const importPrice = EnergyPrice.fromEurPerKwh(0.3);
    const feedInTariff = EnergyPrice.fromEurPerKwh(0.08);

    const importEnergy = Energy.fromKilowattHours(3);
    const exportEnergy = Energy.fromKilowattHours(-2);

    expect(importPrice.costFor(importEnergy).eur).toBeCloseTo(0.9, 9);
    expect(computeGridEnergyCost(importEnergy, importPrice, feedInTariff).eur).toBeCloseTo(0.9, 9);
    expect(computeGridEnergyCost(exportEnergy, importPrice, feedInTariff).eur).toBeCloseTo(-0.16, 9);
  });

  it("supports EnergyPrice addition and duration-weighted averages", () => {
    const importPrice = EnergyPrice.fromEurPerKwh(0.2);
    const gridFee = EnergyPrice.fromEurPerKwh(0.05);
    const blended = importPrice.add(gridFee);

    expect(blended.eurPerKwh).toBeCloseTo(0.25, 9);

    const weightedAverage = EnergyPrice.weightedAverageByDuration([
      {price: EnergyPrice.fromEurPerKwh(0.1), duration: Duration.fromHours(1)},
      {price: EnergyPrice.fromEurPerKwh(0.3), duration: Duration.fromHours(3)},
    ]);

    expect(weightedAverage.eurPerKwh).toBeCloseTo(0.25, 9);
  });
});
