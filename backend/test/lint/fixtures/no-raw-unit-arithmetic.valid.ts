import { Energy, EnergyPrice, computeGridEnergyCost } from "@chargecaster/domain";

export {};

const gridEnergy = Energy.fromKilowattHours(1.25);
const solarEnergy = Energy.fromKilowattHours(0.5);
const importPrice = EnergyPrice.fromEurPerKwh(0.3);
const netGridEnergy = gridEnergy.subtract(solarEnergy);
const slotCost = computeGridEnergyCost(netGridEnergy, importPrice, EnergyPrice.fromEurPerKwh(0.08));

void slotCost;
