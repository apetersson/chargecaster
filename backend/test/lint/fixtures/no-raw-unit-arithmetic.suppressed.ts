export {};

const gridEnergyKwh: number = 1.25;
const availableSolarKwh: number = 0.5;
// eslint-disable-next-line chargecaster/no-raw-unit-arithmetic -- intentional raw-number fixture for suppression coverage
const slotCostEur: number = gridEnergyKwh + availableSolarKwh;

void slotCostEur;
