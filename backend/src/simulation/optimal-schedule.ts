import type { BatteryChemistry, OracleEntry, PriceSlot, SimulationConfig } from "@chargecaster/domain";
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
import { resolveTransitionEfficiencies } from "./battery-efficiency-curve";

const SOC_STEPS = 100;
const EPSILON = 1e-9;
const GRID_CHARGE_STRATEGY_THRESHOLD_KWH = 0.05;

export interface SimulationOptions {
  solarGenerationKwhPerSlot?: number[];
  houseLoadWattsPerSlot?: (number | undefined)[];
  gridFeeEurPerKwhBySlot?: (number | undefined)[];
  feedInTariffEurPerKwh?: number;
  feedInTariffEurPerKwhBySlot?: (number | undefined)[];
  allowBatteryExport?: boolean;
  allowGridChargeFromGrid?: boolean;
  canPreventAutomaticSolarCharging?: boolean;
  optimizerModeAllowList?: OracleEntry["strategy"][];
  chargeEfficiency?: Percentage;
  dischargeEfficiency?: Percentage;
  chargeAverageCRate?: number;
  dischargeAverageCRate?: number;
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
  expected_feed_in_profit_eur: number;
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

export interface PolicyTransition {
  mode: OracleEntry["strategy"];
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
  feedInTariff: EnergyPrice;
  networkTariff: EnergyPrice;
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
  chemistry: BatteryChemistry | null;
  allowBatteryExport: boolean;
  allowGridChargeFromGrid: boolean;
  canPreventAutomaticSolarCharging: boolean;
  optimizerModeAllowList: Set<OracleEntry["strategy"]>;
  chargeEfficiency: Percentage;
  dischargeEfficiency: Percentage;
  chargeAverageCRate: number;
  dischargeAverageCRate: number;
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
  feedInProfitTotal: Money;
  oracleEntries: OracleEntry[];
}

interface StateTransitionSnapshot {
  nextSoCStep: number;
  deltaSoCSteps: number;
  storedEnergyChange: Energy;
  batteryEnergyAtBus: Energy;
  gridEnergy: Energy;
  additionalGridCharge: Energy;
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
    feedInTariffBySlot: slots.map((_, index) => EnergyPrice.fromEurPerKwh(
      Number(options.feedInTariffEurPerKwhBySlot?.[index] ?? options.feedInTariffEurPerKwh ?? price.feed_in_tariff_eur_per_kwh ?? 0),
    )),
    gridFeeBySlot: slots.map((_, index) => EnergyPrice.fromEurPerKwh(
      Number(options.gridFeeEurPerKwhBySlot?.[index] ?? gridFee(cfg)),
    )),
    allowBatteryExport:
      typeof options.allowBatteryExport === "boolean"
        ? options.allowBatteryExport
        : logic.allow_battery_export ?? true,
    allowGridChargeFromGrid:
      typeof options.allowGridChargeFromGrid === "boolean" ? options.allowGridChargeFromGrid : true,
    canPreventAutomaticSolarCharging:
      typeof options.canPreventAutomaticSolarCharging === "boolean" ? options.canPreventAutomaticSolarCharging : true,
    optimizerModeAllowList:
      options.optimizerModeAllowList?.length
        ? options.optimizerModeAllowList
        : cfg.logic.optimizer_modes?.length
          ? cfg.logic.optimizer_modes
          : (["charge", "auto", "hold", "limit"] as const),
    chargeEfficiency: normalizeEfficiency(options.chargeEfficiency),
    dischargeEfficiency: normalizeEfficiency(options.dischargeEfficiency),
    chargeAverageCRate: normalizeAverageCRate(options.chargeAverageCRate),
    dischargeAverageCRate: normalizeAverageCRate(options.dischargeAverageCRate),
  } as const;

  const maxChargePower = Power.fromWatts(Math.max(0, Number(battery.max_charge_power_w ?? 0)));
  const maxSolarChargePower = battery.max_charge_power_solar_w != null
    ? Power.fromWatts(Math.max(0, Number(battery.max_charge_power_solar_w)))
    : null;
  const maxDischargePower = battery.max_discharge_power_w != null
    ? Power.fromWatts(Math.max(0, Number(battery.max_discharge_power_w)))
    : null;
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
    slots.map((slot, index) => ({
      price: slot.energyPrice.add(normalizedOptions.gridFeeBySlot[index] ?? EnergyPrice.fromEurPerKwh(gridFee(cfg))),
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
    feedInTariffBySlot: normalizedOptions.feedInTariffBySlot,
    networkTariffBySlot: normalizedOptions.gridFeeBySlot,
    fallbackHouseLoad,
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
    networkTariff: EnergyPrice.fromEurPerKwh(gridFee(cfg)),
    fallbackHouseLoad,
    capacity,
    maxChargePower,
    maxSolarChargePower,
    maxDischargePower,
    chemistry: battery.chemistry ?? null,
    allowBatteryExport: normalizedOptions.allowBatteryExport,
    allowGridChargeFromGrid: normalizedOptions.allowGridChargeFromGrid,
    canPreventAutomaticSolarCharging: normalizedOptions.canPreventAutomaticSolarCharging,
    optimizerModeAllowList: new Set(normalizedOptions.optimizerModeAllowList),
    chargeEfficiency: normalizedOptions.chargeEfficiency,
    dischargeEfficiency: normalizedOptions.dischargeEfficiency,
    chargeAverageCRate: normalizedOptions.chargeAverageCRate,
    dischargeAverageCRate: normalizedOptions.dischargeAverageCRate,
  };
}

function buildSlotProfiles(params: {
  slots: PriceSlot[];
  solarGenerationPerSlotKwh: number[];
  houseLoadWattsPerSlot: (number | undefined)[];
  feedInTariffBySlot: EnergyPrice[];
  networkTariffBySlot: EnergyPrice[];
  fallbackHouseLoad: Power;
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
    const networkTariff = params.networkTariffBySlot[index] ?? EnergyPrice.fromEurPerKwh(0);
    const priceTotal = slot.energyPrice.add(networkTariff);
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
      feedInTariff: params.feedInTariffBySlot[index] ?? EnergyPrice.fromEurPerKwh(0),
      networkTariff,
      gridChargeLimit,
      solarChargeLimit,
      // The battery may accept the higher solar-only rate, but once grid charging is involved
      // the total charge rate must stay within the grid-backed battery ceiling.
      totalChargeLimit: maxEnergy(gridChargeLimit, solarChargeLimit),
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
      mode: "hold",
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
    canPreventAutomaticSolarCharging,
    optimizerModeAllowList,
  } = context;

  let maxChargeSteps = numSoCStates - 1 - currentSoCStep;
  if (profile.totalChargeLimit.wattHours > 0) {
    maxChargeSteps = Math.min(
      maxChargeSteps,
      Math.floor(profile.totalChargeLimit.kilowattHours * context.chargeEfficiency.ratio / energyPerStep.kilowattHours + EPSILON),
    );
  } else {
    maxChargeSteps = Math.min(maxChargeSteps, 0);
  }
  const upLimit = Math.min(maxChargeSteps, numSoCStates - 1 - currentSoCStep);

  let maxDischargeStepsByPower = currentSoCStep;
  if (profile.dischargeLimit) {
    maxDischargeStepsByPower = Math.min(
      maxDischargeStepsByPower,
      Math.floor(profile.dischargeLimit.kilowattHours / (context.dischargeEfficiency.ratio * energyPerStep.kilowattHours) + EPSILON),
    );
  }
  const allowedDischargeSteps = Math.max(0, currentSoCStep - minAllowedSoCStep);
  const downLimit = Math.max(0, Math.min(maxDischargeStepsByPower, allowedDischargeSteps));
  const autoSignature = optimizerModeAllowList.has("auto")
    ? selectAutoTransitionSignature(context, profile, currentSoCStep, downLimit, upLimit)
    : null;

  let bestCost: Money | null = null;
  let bestTransition: PolicyTransition | null = null;

  for (let deltaSoCSteps = -downLimit; deltaSoCSteps <= upLimit; deltaSoCSteps += 1) {
    const snapshot = buildStateTransitionSnapshot(context, profile, currentSoCStep, deltaSoCSteps);
    const {nextSoCStep, storedEnergyChange, batteryEnergyAtBus, gridEnergy, additionalGridCharge} = snapshot;

    if (nextSoCStep < minAllowedSoCStep) {
      continue;
    }

    if (!allowBatteryExport) {
      const minGridEnergy = profile.baselineGridEnergy.wattHours < 0 ? profile.baselineGridEnergy : Energy.zero();
      if (gridEnergy.kilowattHours < minGridEnergy.kilowattHours - EPSILON) {
        continue;
      }
    }

    if (
      !canPreventAutomaticSolarCharging &&
      deltaSoCSteps <= 0 &&
      gridEnergy.wattHours < -EPSILON &&
      nextSoCStep < maxAllowedSoCStep
    ) {
      continue;
    }

    if (storedEnergyChange.wattHours > 0) {
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
      if (
        additionalGridCharge.kilowattHours > EPSILON &&
        batteryEnergyAtBus.kilowattHours > profile.gridChargeLimit.kilowattHours + EPSILON
      ) {
        continue;
      }
    }

    const explicitMode = resolveExplicitModeForTransition(
      context,
      profile,
      currentSoCStep,
      snapshot,
      autoSignature,
    );
    if (!explicitMode) {
      continue;
    }

    const futureCost = costToGoNextRow[nextSoCStep];
    if (!futureCost) {
      continue;
    }
    const slotCost = computeGridCost(gridEnergy, profile.priceTotal, profile.feedInTariff);
    const totalCost = slotCost.add(futureCost);
    if (
      !bestCost
      || totalCost.eur < bestCost.eur - EPSILON
      || (Math.abs(totalCost.eur - bestCost.eur) <= EPSILON
        && shouldPreferMode(explicitMode, bestTransition?.mode ?? null))
    ) {
      bestCost = totalCost;
      bestTransition = {
        mode: explicitMode,
        nextSoCStep,
        deltaSoCSteps,
      };
    }
  }

  if (!bestCost || !bestTransition) {
    return {
      cost: costToGoNextRow[currentSoCStep] ?? Money.zero(),
      transition: {
        mode: optimizerModeAllowList.has("auto") ? "auto" : "hold",
        nextSoCStep: currentSoCStep,
        deltaSoCSteps: 0,
      },
    };
  }

  return {cost: bestCost, transition: bestTransition};
}

function buildStateTransitionSnapshot(
  context: SimulationContext,
  profile: SlotProfile,
  currentSoCStep: number,
  deltaSoCSteps: number,
): StateTransitionSnapshot {
  const nextSoCStep = currentSoCStep + deltaSoCSteps;
  const storedEnergyChange = context.energyPerStep.multiply(deltaSoCSteps);
  const transitionEfficiencies = resolveTransitionEfficiencies(
    context.chemistry,
    storedEnergyChange,
    profile.duration,
    context.capacity,
    context.chargeEfficiency,
    context.dischargeEfficiency,
    context.chargeAverageCRate,
    context.dischargeAverageCRate,
  );
  const batteryEnergyAtBus = energyAtBusFromStoredEnergyChange(
    storedEnergyChange,
    transitionEfficiencies.chargeEfficiency,
    transitionEfficiencies.dischargeEfficiency,
  );
  const gridEnergy = profile.loadAfterDirectUse.add(batteryEnergyAtBus).subtract(profile.availableSolar);
  const gridImport = maxEnergy(gridEnergy, Energy.zero());
  const additionalGridCharge = storedEnergyChange.wattHours > 0
    ? maxEnergy(gridImport.subtract(profile.baselineGridImport), Energy.zero())
    : Energy.zero();

  return {
    nextSoCStep,
    deltaSoCSteps,
    storedEnergyChange,
    batteryEnergyAtBus,
    gridEnergy,
    additionalGridCharge,
  };
}

function selectAutoTransitionSignature(
  context: SimulationContext,
  profile: SlotProfile,
  currentSoCStep: number,
  downLimit: number,
  upLimit: number,
): StateTransitionSnapshot | null {
  let best: StateTransitionSnapshot | null = null;

  for (let deltaSoCSteps = -downLimit; deltaSoCSteps <= upLimit; deltaSoCSteps += 1) {
    const candidate = buildStateTransitionSnapshot(context, profile, currentSoCStep, deltaSoCSteps);
    if (candidate.additionalGridCharge.wattHours > EPSILON) {
      continue;
    }
    if (candidate.nextSoCStep < context.minAllowedSoCStep || candidate.nextSoCStep > context.maxAllowedSoCStep) {
      continue;
    }
    if (
      !context.allowBatteryExport
      && candidate.gridEnergy.kilowattHours
        < (profile.baselineGridEnergy.wattHours < 0 ? profile.baselineGridEnergy : Energy.zero()).kilowattHours - EPSILON
    ) {
      continue;
    }
    if (!best || isBetterAutoCandidate(candidate, best, profile)) {
      best = candidate;
    }
  }

  return best;
}

function isBetterAutoCandidate(
  candidate: StateTransitionSnapshot,
  incumbent: StateTransitionSnapshot,
  profile: SlotProfile,
): boolean {
  const candidateAbsGrid = Math.abs(candidate.gridEnergy.wattHours);
  const incumbentAbsGrid = Math.abs(incumbent.gridEnergy.wattHours);
  if (candidateAbsGrid < incumbentAbsGrid - EPSILON) {
    return true;
  }
  if (Math.abs(candidateAbsGrid - incumbentAbsGrid) > EPSILON) {
    return false;
  }
  if (profile.availableSolar.wattHours > profile.loadAfterDirectUse.wattHours + EPSILON) {
    return candidate.deltaSoCSteps > incumbent.deltaSoCSteps;
  }
  if (profile.loadAfterDirectUse.wattHours > profile.availableSolar.wattHours + EPSILON) {
    return candidate.deltaSoCSteps < incumbent.deltaSoCSteps;
  }
  return Math.abs(candidate.deltaSoCSteps) > Math.abs(incumbent.deltaSoCSteps);
}

function resolveExplicitModeForTransition(
  context: SimulationContext,
  profile: SlotProfile,
  currentSoCStep: number,
  snapshot: StateTransitionSnapshot,
  autoSignature: StateTransitionSnapshot | null,
): OracleEntry["strategy"] | null {
  const allowedModes = context.optimizerModeAllowList;

  if (
    autoSignature
    && snapshot.deltaSoCSteps === autoSignature.deltaSoCSteps
    && snapshot.nextSoCStep === autoSignature.nextSoCStep
    && allowedModes.has("auto")
  ) {
    return "auto";
  }

  if (snapshot.additionalGridCharge.wattHours > GRID_CHARGE_STRATEGY_THRESHOLD_KWH * 1000) {
    return allowedModes.has("charge") ? "charge" : null;
  }

  if (snapshot.deltaSoCSteps === 0) {
    if (
      allowedModes.has("limit")
      && currentSoCStep === context.minAllowedSoCStep
      && profile.availableSolar.wattHours > EPSILON
    ) {
      return "limit";
    }
    if (allowedModes.has("hold")) {
      return "hold";
    }
  }

  if (allowedModes.has("auto")) {
    return "auto";
  }

  return null;
}

function shouldPreferMode(candidate: OracleEntry["strategy"], incumbent: OracleEntry["strategy"] | null): boolean {
  if (!incumbent) {
    return true;
  }
  const rank = new Map<OracleEntry["strategy"], number>([
    ["limit", 4],
    ["hold", 3],
    ["auto", 2],
    ["charge", 1],
  ]);
  return (rank.get(candidate) ?? 0) > (rank.get(incumbent) ?? 0);
}

function buildSimulationOutput(
  context: SimulationContext,
  policy: PolicyTransition[][],
): SimulationOutput {
  const rollout = runForwardPass(context, policy);
  const {
    socPathSteps,
    costTotal,
    baselineCost,
    gridEnergyTotal,
    gridChargeTotal,
    feedInTotal,
    feedInProfitTotal,
    oracleEntries,
  } = rollout;

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
    expected_feed_in_profit_eur: feedInProfitTotal.eur,
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
  let feedInProfitTotal = Money.zero();
  let socStepIter = context.currentSoCStep;

  for (let index = 0; index < context.horizon; index += 1) {
    const profile = context.slotProfiles[index];
    const transition = policy[index][socStepIter];
    let nextSoCStep = transition.nextSoCStep;
    let deltaSoCSteps = transition.deltaSoCSteps;
    let strategy = transition.mode;
    let storedEnergyChange = context.energyPerStep.multiply(deltaSoCSteps);
    let transitionEfficiencies = resolveTransitionEfficiencies(
      context.chemistry,
      storedEnergyChange,
      profile.duration,
      context.capacity,
      context.chargeEfficiency,
      context.dischargeEfficiency,
      context.chargeAverageCRate,
      context.dischargeAverageCRate,
    );
    let batteryEnergyAtBus = energyAtBusFromStoredEnergyChange(
      storedEnergyChange,
      transitionEfficiencies.chargeEfficiency,
      transitionEfficiencies.dischargeEfficiency,
    );
    const importPrice = profile.priceTotal;
    baselineCost = baselineCost.add(computeGridCost(profile.baselineGridEnergy, importPrice, profile.feedInTariff));
    let gridEnergy = profile.loadAfterDirectUse.add(batteryEnergyAtBus).subtract(profile.availableSolar);

    if (nextSoCStep < context.minAllowedSoCStep) {
      nextSoCStep = context.minAllowedSoCStep;
      deltaSoCSteps = nextSoCStep - socStepIter;
      storedEnergyChange = context.energyPerStep.multiply(deltaSoCSteps);
      transitionEfficiencies = resolveTransitionEfficiencies(
        context.chemistry,
        storedEnergyChange,
        profile.duration,
        context.capacity,
        context.chargeEfficiency,
        context.dischargeEfficiency,
        context.chargeAverageCRate,
        context.dischargeAverageCRate,
      );
      batteryEnergyAtBus = energyAtBusFromStoredEnergyChange(
        storedEnergyChange,
        transitionEfficiencies.chargeEfficiency,
        transitionEfficiencies.dischargeEfficiency,
      );
      gridEnergy = profile.loadAfterDirectUse.add(batteryEnergyAtBus).subtract(profile.availableSolar);
    }

    if (Math.abs(gridEnergy.kilowattHours) < GRID_CHARGE_STRATEGY_THRESHOLD_KWH) {
      gridEnergy = Energy.zero();
    }

    costTotal = costTotal.add(computeGridCost(gridEnergy, importPrice, profile.feedInTariff));
    gridEnergyTotal = gridEnergyTotal.add(gridEnergy);
    if (gridEnergy.wattHours < 0) {
      feedInTotal = feedInTotal.add(Energy.fromWattHours(Math.abs(gridEnergy.wattHours)));
      feedInProfitTotal = feedInProfitTotal.add(computeGridCost(gridEnergy, importPrice, profile.feedInTariff).negate());
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
    if (
      strategy === "hold"
      && Math.abs(deltaSoCSteps) > 0
      && context.optimizerModeAllowList.has("auto")
    ) {
      strategy = "auto";
    }
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
    feedInProfitTotal,
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

function normalizeAverageCRate(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !(value > 0)) {
    return 0.25;
  }
  return value;
}
