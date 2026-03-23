import type { OracleEntry, PriceSlot, SimulationConfig } from "@chargecaster/domain";
import {
  computeGridEnergyCost,
  Duration,
  Energy,
  EnergyPrice,
  Money,
  Percentage,
  Power,
  energyFromPower,
  powerFromEnergy,
} from "@chargecaster/domain";

const SOC_STEPS = 100;
const EPSILON = 1e-9;
const GRID_CHARGE_STRATEGY_THRESHOLD_KWH = 0.05;
const HOLD_ENERGY_THRESHOLD_KWH = 0.02;

export interface SimulationOptions {
  solarGenerationKwhPerSlot?: number[];
  houseLoadWattsPerSlot?: (number | undefined)[];
  feedInTariffEurPerKwh?: number;
  allowBatteryExport?: boolean;
  allowGridChargeFromGrid?: boolean;
  chargeEfficiency?: Percentage;
  dischargeEfficiency?: Percentage;
}

export interface SimulationOutput {
  initial_soc_percent: number;
  next_step_soc_percent: number | null;
  recommended_soc_percent: number | null;
  recommended_final_soc_percent: number | null;
  simulation_runs: number;
  projected_cost_eur: number;
  baseline_cost_eur: number;
  projected_savings_eur: number;
  projected_grid_power_w: number;
  expected_feed_in_kwh: number;
  average_price_eur_per_kwh: number;
  forecast_samples: number;
  forecast_hours: number;
  oracle_entries: OracleEntry[];
  timestamp: string;
}

export function gridFee(cfg: SimulationConfig): number {
  const value = cfg.price.grid_fee_eur_per_kwh ?? 0;
  return Number(value) || 0;
}

export enum TransitionKind {
  Hold = "hold",
  Charge = "charge",
  Discharge = "discharge",
}

export interface PolicyTransition {
  kind: TransitionKind;
  nextSoCStep: number;
  deltaSoCSteps: number;
}

interface SlotProfile {
  index: number;
  slot: PriceSlot;
  duration: Duration;
  loadEnergy: Energy;
  solarGeneration: Energy;
  directUseEnergy: Energy;
  loadAfterDirectUse: Energy;
  availableSolar: Energy;
  priceTotal: EnergyPrice;
  baselineGridEnergy: Energy;
  baselineGridImport: Energy;
  gridChargeLimit: Energy;
  solarChargeLimit: Energy;
  totalChargeLimit: Energy;
  dischargeLimit: Energy | null;
}

interface SimulationContext {
  cfg: SimulationConfig;
  slots: PriceSlot[];
  slotProfiles: SlotProfile[];
  socPercentStep: number;
  energyPerStep: Energy;
  numSoCStates: number;
  maxAllowedSoCStep: number;
  minAllowedSoCStep: number;
  horizon: number;
  avgPrice: EnergyPrice;
  totalDuration: Duration;
  currentSoCStep: number;
  currentSoC: Percentage;
  minAllowedSoc: Percentage;
  maxChargeSoC: Percentage;
  networkTariff: EnergyPrice;
  fallbackHouseLoad: Power;
  capacity: Energy;
  maxChargePower: Power;
  maxSolarChargePower: Power | null;
  maxDischargePower: Power | null;
  feedInTariff: EnergyPrice;
  allowBatteryExport: boolean;
  allowGridChargeFromGrid: boolean;
  chargeEfficiency: Percentage;
  dischargeEfficiency: Percentage;
}

interface DynamicProgrammingResult {
  policy: PolicyTransition[][];
}

interface RolloutResult {
  socPathSteps: number[];
  costTotal: Money;
  baselineCost: Money;
  gridEnergyTotal: Energy;
  gridChargeTotal: Energy;
  feedInTotal: Energy;
  oracleEntries: OracleEntry[];
}

interface StateTransitionSnapshot {
  nextSoCStep: number;
  deltaSoCSteps: number;
  storedEnergyChange: Energy;
  batteryEnergyAtBus: Energy;
  gridEnergy: Energy;
}

export function simulateOptimalSchedule(
  cfg: SimulationConfig,
  liveState: { battery_soc?: number | null },
  slots: PriceSlot[],
  options: SimulationOptions = {},
): SimulationOutput {
  const context = prepareSimulationContext(cfg, liveState, slots, options);
  const {policy} = runBackwardPass(context);
  return buildSimulationOutput(context, policy);
}

function prepareSimulationContext(
  cfg: SimulationConfig,
  liveState: { battery_soc?: number | null },
  slots: PriceSlot[],
  options: SimulationOptions,
): SimulationContext {
  if (slots.length === 0) {
    throw new Error("price forecast is empty");
  }

  const {battery, price, logic} = cfg;

  const capacity = Energy.fromKilowattHours(Number(battery.capacity_kwh ?? 0));
  if (!(capacity.wattHours > 0)) {
    throw new Error("battery.capacity_kwh must be > 0");
  }

  const normalizedOptions = {
    solarGenerationPerSlotKwh: options.solarGenerationKwhPerSlot ?? [],
    houseLoadWattsPerSlot: options.houseLoadWattsPerSlot ?? [],
    feedInTariff: EnergyPrice.fromEurPerKwh(
      Math.max(
        0,
        Number(options.feedInTariffEurPerKwh ?? price.feed_in_tariff_eur_per_kwh ?? 0),
      ),
    ),
    allowBatteryExport:
      typeof options.allowBatteryExport === "boolean"
        ? options.allowBatteryExport
        : logic.allow_battery_export ?? true,
    allowGridChargeFromGrid:
      typeof options.allowGridChargeFromGrid === "boolean" ? options.allowGridChargeFromGrid : true,
    chargeEfficiency: normalizeEfficiency(options.chargeEfficiency),
    dischargeEfficiency: normalizeEfficiency(options.dischargeEfficiency),
  } as const;

  const maxChargePower = Power.fromWatts(Math.max(0, Number(battery.max_charge_power_w ?? 0)));
  const maxSolarChargePower = battery.max_charge_power_solar_w != null
    ? Power.fromWatts(Math.max(0, Number(battery.max_charge_power_solar_w)))
    : null;
  const maxDischargePower = battery.max_discharge_power_w != null
    ? Power.fromWatts(Math.max(0, Number(battery.max_discharge_power_w)))
    : null;
  const networkTariff = EnergyPrice.fromEurPerKwh(gridFee(cfg));
  const fallbackHouseLoad = Power.fromWatts(2200);

  let currentSoCPercent = Number(liveState.battery_soc ?? 50);
  if (Number.isNaN(currentSoCPercent)) {
    currentSoCPercent = 50;
  }
  currentSoCPercent = Math.min(100, Math.max(0, currentSoCPercent));
  const currentSoC = Percentage.fromPercent(currentSoCPercent);

  const socPercentStep = 100 / SOC_STEPS;
  const energyPerStep = capacity.multiply(1 / SOC_STEPS);
  const minAllowedSoc = (() => {
    const value = battery.auto_mode_floor_soc;
    if (typeof value === "number" && Number.isFinite(value)) {
      return Percentage.fromPercent(Math.min(Math.max(value, 0), 100));
    }
    return Percentage.zero();
  })();
  const maxChargeSoC = (() => {
    const value = battery.max_charge_soc_percent;
    if (typeof value === "number" && Number.isFinite(value)) {
      return Percentage.fromPercent(Math.min(Math.max(value, 0), 100));
    }
    return Percentage.full();
  })();

  let minAllowedSoCStep = Math.max(0, Math.ceil(minAllowedSoc.percent / socPercentStep - EPSILON));
  const maxPossibleStep = Math.round(100 / socPercentStep);
  if (minAllowedSoCStep > maxPossibleStep) {
    minAllowedSoCStep = maxPossibleStep;
  }
  minAllowedSoCStep = Math.min(minAllowedSoCStep, Math.round(maxChargeSoC.percent / socPercentStep));

  const totalDuration = slots.reduce(
    (accumulator, slot) => accumulator.add(slot.duration),
    Duration.zero(),
  );
  if (totalDuration.milliseconds <= 0) {
    throw new Error("price forecast has zero duration");
  }

  const avgPrice = EnergyPrice.weightedAverageByDuration(
    slots.map((slot) => ({
      price: slot.energyPrice.add(networkTariff),
      duration: slot.duration,
    })),
  );

  const numSoCStates = SOC_STEPS + 1;
  const maxAllowedSoCStep = Math.round(maxChargeSoC.percent / socPercentStep);
  const horizon = slots.length;
  const currentSoCStep = Math.max(
    0,
    Math.min(numSoCStates - 1, Math.round(currentSoC.percent / socPercentStep)),
  );

  const slotProfiles = buildSlotProfiles({
    slots,
    solarGenerationPerSlotKwh: normalizedOptions.solarGenerationPerSlotKwh,
    houseLoadWattsPerSlot: normalizedOptions.houseLoadWattsPerSlot,
    fallbackHouseLoad,
    networkTariff,
    allowGridChargeFromGrid: normalizedOptions.allowGridChargeFromGrid,
    maxChargePower,
    maxSolarChargePower,
    maxDischargePower,
  });

  return {
    cfg,
    slots,
    slotProfiles,
    socPercentStep,
    energyPerStep,
    numSoCStates,
    maxAllowedSoCStep,
    minAllowedSoCStep,
    horizon,
    avgPrice,
    totalDuration,
    currentSoCStep,
    currentSoC,
    minAllowedSoc,
    maxChargeSoC,
    networkTariff,
    fallbackHouseLoad,
    capacity,
    maxChargePower,
    maxSolarChargePower,
    maxDischargePower,
    feedInTariff: normalizedOptions.feedInTariff,
    allowBatteryExport: normalizedOptions.allowBatteryExport,
    allowGridChargeFromGrid: normalizedOptions.allowGridChargeFromGrid,
    chargeEfficiency: normalizedOptions.chargeEfficiency,
    dischargeEfficiency: normalizedOptions.dischargeEfficiency,
  };
}

function buildSlotProfiles(params: {
  slots: PriceSlot[];
  solarGenerationPerSlotKwh: number[];
  houseLoadWattsPerSlot: (number | undefined)[];
  fallbackHouseLoad: Power;
  networkTariff: EnergyPrice;
  allowGridChargeFromGrid: boolean;
  maxChargePower: Power;
  maxSolarChargePower: Power | null;
  maxDischargePower: Power | null;
}): SlotProfile[] {
  return params.slots.map((slot, index) => {
    const duration = slot.duration;
    const solarGeneration = Energy.fromKilowattHours(params.solarGenerationPerSlotKwh[index] ?? 0);
    const explicitLoadEnergy = energyFromOptionalPowerWatts(params.houseLoadWattsPerSlot[index], duration);
    const loadEnergy = explicitLoadEnergy ?? params.fallbackHouseLoad.forDuration(duration);
    const directUseEnergy = minEnergy(loadEnergy, solarGeneration);
    const loadAfterDirectUse = loadEnergy.subtract(directUseEnergy);
    const availableSolar = solarGeneration.subtract(directUseEnergy);
    const priceTotal = slot.energyPrice.add(params.networkTariff);
    const baselineGridEnergy = loadAfterDirectUse.subtract(availableSolar);
    const baselineGridImport = maxEnergy(baselineGridEnergy, Energy.zero());
    const gridChargeLimit = params.allowGridChargeFromGrid && params.maxChargePower.watts > 0
      ? params.maxChargePower.forDuration(duration)
      : Energy.zero();
    const solarChargeLimit = availableSolar.wattHours <= 0
      ? Energy.zero()
      : params.maxSolarChargePower
        ? minEnergy(availableSolar, params.maxSolarChargePower.forDuration(duration))
        : availableSolar;
    const dischargeLimit = params.maxDischargePower
      ? params.maxDischargePower.forDuration(duration)
      : null;

    return {
      index,
      slot,
      duration,
      loadEnergy,
      solarGeneration,
      directUseEnergy,
      loadAfterDirectUse,
      availableSolar,
      priceTotal,
      baselineGridEnergy,
      baselineGridImport,
      gridChargeLimit,
      solarChargeLimit,
      totalChargeLimit: gridChargeLimit.add(solarChargeLimit),
      dischargeLimit,
    } satisfies SlotProfile;
  });
}

function runBackwardPass(context: SimulationContext): DynamicProgrammingResult {
  const {horizon, numSoCStates, avgPrice, energyPerStep, slotProfiles} = context;
  const costToGoTable: (Money | null)[][] = Array.from({length: horizon + 1}, () =>
    Array.from({length: numSoCStates}, () => null),
  );
  const policy: PolicyTransition[][] = Array.from({length: horizon}, () =>
    Array.from({length: numSoCStates}, () => ({
      kind: TransitionKind.Hold,
      nextSoCStep: 0,
      deltaSoCSteps: 0,
    })),
  );

  for (let socStep = 0; socStep < numSoCStates; socStep += 1) {
    const energy = energyPerStep.multiply(socStep);
    costToGoTable[horizon][socStep] = avgPrice.costFor(energy).negate();
  }

  for (let index = horizon - 1; index >= 0; index -= 1) {
    const profile = slotProfiles[index];
    const nextRow = costToGoTable[index + 1];
    for (let socStep = 0; socStep < numSoCStates; socStep += 1) {
      const evaluation = evaluateStateTransitions(context, profile, socStep, nextRow);
      costToGoTable[index][socStep] = evaluation.cost;
      policy[index][socStep] = evaluation.transition;
    }
  }

  return {policy};
}

function evaluateStateTransitions(
  context: SimulationContext,
  profile: SlotProfile,
  currentSoCStep: number,
  costToGoNextRow: (Money | null)[],
): { cost: Money; transition: PolicyTransition } {
  const {
    energyPerStep,
    numSoCStates,
    maxAllowedSoCStep,
    minAllowedSoCStep,
    allowBatteryExport,
    feedInTariff,
    chargeEfficiency,
    dischargeEfficiency,
  } = context;

  let maxChargeSteps = numSoCStates - 1 - currentSoCStep;
  if (profile.totalChargeLimit.wattHours > 0) {
    maxChargeSteps = Math.min(
      maxChargeSteps,
      Math.floor(profile.totalChargeLimit.kilowattHours * chargeEfficiency.ratio / energyPerStep.kilowattHours + EPSILON),
    );
  } else {
    maxChargeSteps = Math.min(maxChargeSteps, 0);
  }
  const upLimit = Math.min(maxChargeSteps, numSoCStates - 1 - currentSoCStep);

  let maxDischargeStepsByPower = currentSoCStep;
  if (profile.dischargeLimit) {
    maxDischargeStepsByPower = Math.min(
      maxDischargeStepsByPower,
      Math.floor(profile.dischargeLimit.kilowattHours / (dischargeEfficiency.ratio * energyPerStep.kilowattHours) + EPSILON),
    );
  }
  const allowedDischargeSteps = Math.max(0, currentSoCStep - minAllowedSoCStep);
  const downLimit = Math.max(0, Math.min(maxDischargeStepsByPower, allowedDischargeSteps));

  let bestCost: Money | null = null;
  let bestTransition: PolicyTransition | null = null;

  for (let deltaSoCSteps = -downLimit; deltaSoCSteps <= upLimit; deltaSoCSteps += 1) {
    const nextSoCStep = currentSoCStep + deltaSoCSteps;
    const storedEnergyChange = energyPerStep.multiply(deltaSoCSteps);
    const batteryEnergyAtBus = energyAtBusFromStoredEnergyChange(
      storedEnergyChange,
      chargeEfficiency,
      dischargeEfficiency,
    );
    const gridEnergy = profile.loadAfterDirectUse.add(batteryEnergyAtBus).subtract(profile.availableSolar);

    if (nextSoCStep < minAllowedSoCStep) {
      continue;
    }

    if (!pvCanExportUnderState(context, profile, currentSoCStep, storedEnergyChange, batteryEnergyAtBus, gridEnergy)) {
      continue;
    }

    if (!allowBatteryExport) {
      const minGridEnergy = profile.baselineGridEnergy.wattHours < 0 ? profile.baselineGridEnergy : Energy.zero();
      if (gridEnergy.kilowattHours < minGridEnergy.kilowattHours - EPSILON) {
        continue;
      }
    }

    if (storedEnergyChange.wattHours > 0) {
      const gridImport = maxEnergy(gridEnergy, Energy.zero());
      const additionalGridCharge = maxEnergy(gridImport.subtract(profile.baselineGridImport), Energy.zero());

      if (nextSoCStep > maxAllowedSoCStep && additionalGridCharge.kilowattHours > EPSILON) {
        continue;
      }

      if (additionalGridCharge.kilowattHours > profile.gridChargeLimit.kilowattHours + EPSILON) {
        continue;
      }
      const solarCharging = maxEnergy(batteryEnergyAtBus.subtract(additionalGridCharge), Energy.zero());
      if (solarCharging.kilowattHours > profile.solarChargeLimit.kilowattHours + EPSILON) {
        continue;
      }
    }

    const futureCost = costToGoNextRow[nextSoCStep];
    if (!futureCost) {
      continue;
    }
    const slotCost = computeGridCost(gridEnergy, profile.priceTotal, feedInTariff);
    const totalCost = slotCost.add(futureCost);
    if (!bestCost || totalCost.eur < bestCost.eur) {
      bestCost = totalCost;
      bestTransition = {
        kind:
          deltaSoCSteps > 0
            ? TransitionKind.Charge
            : deltaSoCSteps < 0
              ? TransitionKind.Discharge
              : TransitionKind.Hold,
        nextSoCStep,
        deltaSoCSteps,
      };
    }
  }

  if (!bestCost || !bestTransition) {
    return {
      cost: costToGoNextRow[currentSoCStep] ?? Money.zero(),
      transition: {
        kind: TransitionKind.Hold,
        nextSoCStep: currentSoCStep,
        deltaSoCSteps: 0,
      },
    };
  }

  return {cost: bestCost, transition: bestTransition};
}

function pvCanExportUnderState(
  context: SimulationContext,
  profile: SlotProfile,
  socStep: number,
  storedEnergyChange: Energy,
  batteryEnergyAtBus: Energy,
  gridEnergy: Energy,
): boolean {
  if (gridEnergy.wattHours >= 0) {
    return true;
  }
  const socStepsToFull = Math.max(0, (context.numSoCStates - 1) - socStep);
  if (socStepsToFull <= 0) {
    return true;
  }
  const socHeadroom = context.energyPerStep.multiply(socStepsToFull);
  const requiredToAvoidExport = maxEnergy(profile.availableSolar.subtract(profile.loadAfterDirectUse), Energy.zero());
  const headroomAtBus = socHeadroom.multiply(1 / context.chargeEfficiency.ratio);
  const requiredCharge = minEnergy(requiredToAvoidExport, minEnergy(profile.solarChargeLimit, headroomAtBus));
  if (!(requiredCharge.kilowattHours > EPSILON)) {
    return true;
  }
  return batteryEnergyAtBus.kilowattHours + EPSILON >= requiredCharge.kilowattHours || storedEnergyChange.wattHours <= 0;
}

function buildSimulationOutput(
  context: SimulationContext,
  policy: PolicyTransition[][],
): SimulationOutput {
  const rollout = runForwardPass(context, policy);
  const {socPathSteps, costTotal, baselineCost, gridEnergyTotal, gridChargeTotal, feedInTotal, oracleEntries} = rollout;

  const finalEnergy = context.energyPerStep.multiply(socPathSteps[socPathSteps.length - 1]);
  const adjustedCost = costTotal.subtract(context.avgPrice.costFor(finalEnergy));
  const adjustedBaseline = baselineCost.subtract(context.avgPrice.costFor(finalEnergy));
  const projectedSavings = adjustedBaseline.subtract(adjustedCost);
  const projectedGridPower = powerFromEnergy(gridEnergyTotal, context.totalDuration);

  const shouldChargeFromGrid = gridChargeTotal.kilowattHours > 0.001;
  const firstTarget = oracleEntries.length > 0
    ? oracleEntries[0].end_soc_percent ?? oracleEntries[0].target_soc_percent ?? null
    : null;
  const finalTarget = oracleEntries.length > 0
    ? oracleEntries[oracleEntries.length - 1].end_soc_percent ?? oracleEntries[oracleEntries.length - 1].target_soc_percent ?? null
    : null;
  const recommendedTargetRaw = shouldChargeFromGrid ? context.maxChargeSoC.percent : (finalTarget ?? context.maxChargeSoC.percent);
  const recommendedTarget = Math.max(
    context.minAllowedSoc.percent,
    Math.min(recommendedTargetRaw, context.maxChargeSoC.percent),
  );
  const nextStepSocPercentRaw = firstTarget ?? context.currentSoCStep * context.socPercentStep;
  const nextStepSocPercent = Math.max(context.minAllowedSoc.percent, nextStepSocPercentRaw);

  return {
    initial_soc_percent: Math.max(context.minAllowedSoc.percent, context.currentSoC.percent),
    next_step_soc_percent: nextStepSocPercent,
    recommended_soc_percent: recommendedTarget,
    recommended_final_soc_percent: recommendedTarget,
    simulation_runs: SOC_STEPS,
    projected_cost_eur: adjustedCost.eur,
    baseline_cost_eur: adjustedBaseline.eur,
    projected_savings_eur: projectedSavings.eur,
    projected_grid_power_w: projectedGridPower.watts,
    expected_feed_in_kwh: feedInTotal.kilowattHours,
    average_price_eur_per_kwh: context.avgPrice.eurPerKwh,
    forecast_samples: context.slots.length,
    forecast_hours: context.totalDuration.hours,
    oracle_entries: oracleEntries,
    timestamp: new Date().toISOString(),
  };
}

function runForwardPass(context: SimulationContext, policy: PolicyTransition[][]): RolloutResult {
  const socPathSteps: number[] = [context.currentSoCStep];
  const oracleEntries: OracleEntry[] = [];
  let costTotal = Money.zero();
  let baselineCost = Money.zero();
  let gridEnergyTotal = Energy.zero();
  let gridChargeTotal = Energy.zero();
  let feedInTotal = Energy.zero();
  let socStepIter = context.currentSoCStep;

  for (let index = 0; index < context.horizon; index += 1) {
    const profile = context.slotProfiles[index];
    const transition = policy[index][socStepIter];
    let nextSoCStep = transition.nextSoCStep;
    let deltaSoCSteps = transition.deltaSoCSteps;
    let storedEnergyChange = context.energyPerStep.multiply(deltaSoCSteps);
    let batteryEnergyAtBus = energyAtBusFromStoredEnergyChange(
      storedEnergyChange,
      context.chargeEfficiency,
      context.dischargeEfficiency,
    );
    const importPrice = profile.priceTotal;
    baselineCost = baselineCost.add(computeGridCost(profile.baselineGridEnergy, importPrice, context.feedInTariff));
    let gridEnergy = profile.loadAfterDirectUse.add(batteryEnergyAtBus).subtract(profile.availableSolar);

    ({nextSoCStep, deltaSoCSteps, storedEnergyChange, batteryEnergyAtBus, gridEnergy} = adjustForPvExportDuringRollout(
      context,
      profile,
      socStepIter,
      {nextSoCStep, deltaSoCSteps, storedEnergyChange, batteryEnergyAtBus, gridEnergy},
    ));

    if (nextSoCStep < context.minAllowedSoCStep) {
      nextSoCStep = context.minAllowedSoCStep;
      deltaSoCSteps = nextSoCStep - socStepIter;
      storedEnergyChange = context.energyPerStep.multiply(deltaSoCSteps);
      batteryEnergyAtBus = energyAtBusFromStoredEnergyChange(
        storedEnergyChange,
        context.chargeEfficiency,
        context.dischargeEfficiency,
      );
      gridEnergy = profile.loadAfterDirectUse.add(batteryEnergyAtBus).subtract(profile.availableSolar);
    }

    if (Math.abs(gridEnergy.kilowattHours) < GRID_CHARGE_STRATEGY_THRESHOLD_KWH) {
      gridEnergy = Energy.zero();
    }

    costTotal = costTotal.add(computeGridCost(gridEnergy, importPrice, context.feedInTariff));
    gridEnergyTotal = gridEnergyTotal.add(gridEnergy);
    if (gridEnergy.wattHours < 0) {
      feedInTotal = feedInTotal.add(Energy.fromWattHours(Math.abs(gridEnergy.wattHours)));
    }
    const gridImport = maxEnergy(gridEnergy, Energy.zero());
    const additionalGridChargeRaw = storedEnergyChange.wattHours > 0
      ? maxEnergy(gridImport.subtract(profile.baselineGridImport), Energy.zero())
      : Energy.zero();
    const additionalGridCharge =
      additionalGridChargeRaw.kilowattHours > GRID_CHARGE_STRATEGY_THRESHOLD_KWH
        ? additionalGridChargeRaw
        : Energy.zero();
    if (additionalGridCharge.wattHours > 0) {
      gridChargeTotal = gridChargeTotal.add(additionalGridCharge);
    }
    socPathSteps.push(nextSoCStep);

    const eraId =
      typeof profile.slot.eraId === "string" && profile.slot.eraId.length > 0
        ? profile.slot.eraId
        : profile.slot.start.toISOString();
    const startSocPercent = socStepIter * context.socPercentStep;
    const endSocPercent = nextSoCStep * context.socPercentStep;
    const normalizedGridEnergyWh = Number.isFinite(gridEnergy.wattHours)
      ? gridEnergy.wattHours
      : null;
    const isHoldTransition =
      Math.abs(deltaSoCSteps) === 0 &&
      Math.abs(storedEnergyChange.kilowattHours) <= HOLD_ENERGY_THRESHOLD_KWH &&
      additionalGridCharge.kilowattHours <= GRID_CHARGE_STRATEGY_THRESHOLD_KWH;
    const strategy: OracleEntry["strategy"] = additionalGridCharge.wattHours > 0
      ? "charge"
      : isHoldTransition
        ? "hold"
        : "auto";
    oracleEntries.push({
      era_id: eraId,
      start_soc_percent: Number.isFinite(startSocPercent) ? startSocPercent : null,
      end_soc_percent: Number.isFinite(endSocPercent) ? endSocPercent : null,
      target_soc_percent: Number.isFinite(endSocPercent) ? endSocPercent : null,
      grid_energy_wh: normalizedGridEnergyWh,
      strategy,
    });

    socStepIter = nextSoCStep;
  }

  return {
    socPathSteps,
    costTotal,
    baselineCost,
    gridEnergyTotal,
    gridChargeTotal,
    feedInTotal,
    oracleEntries,
  };
}

function energyFromOptionalPowerWatts(powerWatts: number | undefined, duration: Duration): Energy | null {
  if (typeof powerWatts !== "number" || !Number.isFinite(powerWatts)) {
    return null;
  }
  return energyFromPower(Power.fromWatts(Math.max(0, powerWatts)), duration);
}

function computeGridCost(gridEnergy: Energy, importPrice: EnergyPrice, feedInTariff: EnergyPrice): Money {
  return computeGridEnergyCost(gridEnergy, importPrice, feedInTariff);
}

function adjustForPvExportDuringRollout(
  context: SimulationContext,
  profile: SlotProfile,
  socStepIter: number,
  input: StateTransitionSnapshot,
): StateTransitionSnapshot {
  let {nextSoCStep, deltaSoCSteps, storedEnergyChange, batteryEnergyAtBus, gridEnergy} = input;
  if (gridEnergy.wattHours < 0) {
    const socStepsToFull = Math.max(0, (context.numSoCStates - 1) - socStepIter);
    const socHeadroom = context.energyPerStep.multiply(socStepsToFull);
    const requiredToAvoidExport = maxEnergy(profile.availableSolar.subtract(profile.loadAfterDirectUse), Energy.zero());
    const headroomAtBus = socHeadroom.multiply(1 / context.chargeEfficiency.ratio);
    const requiredCharge = minEnergy(requiredToAvoidExport, minEnergy(profile.solarChargeLimit, headroomAtBus));
    if (requiredCharge.kilowattHours > batteryEnergyAtBus.kilowattHours + EPSILON && socHeadroom.kilowattHours > EPSILON) {
      const extraAtBus = minEnergy(
        requiredCharge.subtract(batteryEnergyAtBus),
        headroomAtBus,
      );
      const extraStored = extraAtBus.multiply(context.chargeEfficiency.ratio);
      const extraSteps = Math.max(0, Math.ceil(extraStored.kilowattHours / context.energyPerStep.kilowattHours - EPSILON));
      if (extraSteps > 0) {
        nextSoCStep = Math.min(context.numSoCStates - 1, nextSoCStep + extraSteps);
        deltaSoCSteps = nextSoCStep - socStepIter;
        storedEnergyChange = context.energyPerStep.multiply(deltaSoCSteps);
        batteryEnergyAtBus = energyAtBusFromStoredEnergyChange(
          storedEnergyChange,
          context.chargeEfficiency,
          context.dischargeEfficiency,
        );
        gridEnergy = profile.loadAfterDirectUse.add(batteryEnergyAtBus).subtract(profile.availableSolar);
      }
      if (gridEnergy.kilowattHours < -EPSILON) {
        const targetStored = requiredCharge.multiply(context.chargeEfficiency.ratio);
        const targetSteps = Math.max(0, Math.ceil(targetStored.kilowattHours / context.energyPerStep.kilowattHours - EPSILON));
        if (targetSteps > 0) {
          nextSoCStep = Math.min(context.numSoCStates - 1, socStepIter + targetSteps);
          deltaSoCSteps = nextSoCStep - socStepIter;
          storedEnergyChange = context.energyPerStep.multiply(deltaSoCSteps);
          batteryEnergyAtBus = energyAtBusFromStoredEnergyChange(
            storedEnergyChange,
            context.chargeEfficiency,
            context.dischargeEfficiency,
          );
          gridEnergy = profile.loadAfterDirectUse.add(batteryEnergyAtBus).subtract(profile.availableSolar);
        }
      }
    }
  }
  return {nextSoCStep, deltaSoCSteps, storedEnergyChange, batteryEnergyAtBus, gridEnergy};
}

function energyAtBusFromStoredEnergyChange(
  storedEnergyChange: Energy,
  chargeEfficiency: Percentage,
  dischargeEfficiency: Percentage,
): Energy {
  if (storedEnergyChange.wattHours > 0) {
    return storedEnergyChange.multiply(1 / chargeEfficiency.ratio);
  }
  if (storedEnergyChange.wattHours < 0) {
    return storedEnergyChange.multiply(dischargeEfficiency.ratio);
  }
  return Energy.zero();
}

function minEnergy(left: Energy, right: Energy): Energy {
  return left.wattHours <= right.wattHours ? left : right;
}

function maxEnergy(left: Energy, right: Energy): Energy {
  return left.wattHours >= right.wattHours ? left : right;
}

function normalizeEfficiency(value: Percentage | undefined): Percentage {
  if (!(value instanceof Percentage)) {
    return Percentage.full();
  }
  return Percentage.fromRatio(Math.min(0.999, Math.max(0.5, value.ratio)));
}
