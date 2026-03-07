import { Duration } from "./duration";
import { Energy } from "./energy";
import { Percentage } from "./percentage";
import { Power } from "./power";
import { EnergyPrice } from "./price";

export function clampRatio(value: unknown): Percentage {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return Percentage.zero();
  }
  return Percentage.fromRatio(numeric);
}

export function energyFromPower(power: Power, duration: Duration): Energy {
  return power.forDuration(duration);
}

export function powerFromEnergy(energy: Energy, duration: Duration): Power {
  return energy.divideByDuration(duration);
}

export function energyFromSoc(soc: Percentage, capacity: Energy): Energy {
  return capacity.multiply(soc);
}

export function socFromEnergy(energy: Energy, capacity: Energy): Percentage {
  if (capacity.wattHours === 0) {
    return Percentage.zero();
  }
  return Percentage.fromRatio(energy.wattHours / capacity.wattHours);
}

export function energyDeltaFromSocPercent(percentDelta: number, capacity: Energy): Energy {
  if (!Number.isFinite(percentDelta)) {
    return Energy.zero();
  }
  return Energy.fromWattHours(capacity.wattHours * (percentDelta / 100));
}

export function inferBatteryPowerFromSocDelta(
  currentSoc: Percentage,
  nextSoc: Percentage,
  capacity: Energy,
  duration: Duration,
): Power {
  const storedEnergyDelta = Energy.fromWattHours(
    capacity.wattHours * (nextSoc.ratio - currentSoc.ratio),
  );
  return Power.fromWatts(-powerFromEnergy(storedEnergyDelta, duration).watts);
}

export function computeGridEnergyCostEur(
  gridEnergy: Energy,
  importPrice: EnergyPrice,
  feedInTariff: EnergyPrice,
): number {
  return gridEnergy.wattHours >= 0
    ? importPrice.costFor(gridEnergy)
    : feedInTariff.costFor(gridEnergy);
}
