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
import type {
  BatteryControlModeDefinition,
  BatteryControlModeParameters,
  BatteryControlSlotOutcome,
  BatteryControlSlotScenario,
} from "../hardware/battery-control-backend";
import { buildGenericBatteryControlCapabilities } from "../hardware/battery-control-backend";
import { resolveTransitionEfficiencies } from "./battery-efficiency-curve";

const SOC_STEPS = 100;
const EPSILON = 1e-9;
const GRID_CHARGE_STRATEGY_THRESHOLD_KWH = 0.05;
const LIMIT_HEADROOM_FUTURE_PRICE_ADVANTAGE_EUR_PER_KWH = 0.05;
const LIMIT_HEADROOM_MIN_SOC_FRACTION = 0.5;

export interface SimulationOptions {
  solarGenerationKwhPerSlot?: number[];
  houseLoadWattsPerSlot?: (number | undefined)[];
  gridFeeEurPerKwhBySlot?: (number | undefined)[];
  feedInTariffEurPerKwh?: number;
  feedInTariffEurPerKwhBySlot?: (number | undefined)[];
  allowBatteryExport?: boolean;
  allowGridChargeFromGrid?: boolean;
  canPreventAutomaticSolarCharging?: boolean;
  modeDefinitions?: BatteryControlModeDefinition[];
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
  modeParameters: BatteryControlModeParameters | null;
  nextSoCStep: number;
  deltaSoCSteps: number;
  gridEnergy: Energy;
  additionalGridCharge: Energy;
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
  modeDefinitions: BatteryControlModeDefinition[];
  chargeEfficiency: Percentage;
  dischargeEfficiency: Percentage;
  chargeAverageCRate: number;
  dischargeAverageCRate: number;
  minFutureImportPriceBySlot: number[];
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
    modeDefinitions:
      options.modeDefinitions?.length
        ? options.modeDefinitions
        : buildGenericBatteryControlCapabilities().modes.filter((mode) =>
            cfg.logic.optimizer_modes?.length ? cfg.logic.optimizer_modes.includes(mode.id) : true,
          ),
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
    modeDefinitions: normalizedOptions.modeDefinitions,
    chargeEfficiency: normalizedOptions.chargeEfficiency,
    dischargeEfficiency: normalizedOptions.dischargeEfficiency,
    chargeAverageCRate: normalizedOptions.chargeAverageCRate,
    dischargeAverageCRate: normalizedOptions.dischargeAverageCRate,
    minFutureImportPriceBySlot: buildMinFutureImportPriceBySlot(slotProfiles),
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
      modeParameters: null,
      nextSoCStep: 0,
      deltaSoCSteps: 0,
      gridEnergy: Energy.zero(),
      additionalGridCharge: Energy.zero(),
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
  const {allowBatteryExport, canPreventAutomaticSolarCharging, modeDefinitions} = context;
  const scenario = buildSlotScenario(context, profile, currentSoCStep);

  let bestCost: Money | null = null;
  let bestTransition: PolicyTransition | null = null;

  for (const modeDefinition of modeDefinitions) {
    for (const parameters of modeDefinition.enumerateParameters(scenario)) {
      const outcome = modeDefinition.applySlotScenario(scenario, parameters);
      if (!outcome) {
        continue;
      }
      if (shouldRejectLimitUnderCurrentSolar(context, profile, currentSoCStep, outcome.mode)) {
        continue;
      }
      const {nextSoCStep} = outcome;
      const gridEnergy = Energy.fromWattHours(outcome.gridEnergyWh);
      const additionalGridCharge = Energy.fromWattHours(outcome.additionalGridChargeWh);

      if (!allowBatteryExport) {
        const minGridEnergy = profile.baselineGridEnergy.wattHours < 0 ? profile.baselineGridEnergy : Energy.zero();
        if (gridEnergy.kilowattHours < minGridEnergy.kilowattHours - EPSILON) {
          continue;
        }
      }

      if (
        !canPreventAutomaticSolarCharging &&
        outcome.mode !== "auto" &&
        gridEnergy.wattHours < -EPSILON &&
        nextSoCStep < context.maxAllowedSoCStep
      ) {
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
          && shouldPreferTransition(
            {
              mode: outcome.mode,
              nextSoCStep,
              additionalGridCharge,
            },
            bestTransition,
          ))
      ) {
        bestCost = totalCost;
        bestTransition = {
          mode: outcome.mode,
          modeParameters: outcome.parameters,
          nextSoCStep,
          deltaSoCSteps: outcome.deltaSoCSteps,
          gridEnergy,
          additionalGridCharge,
        };
      }
    }
  }

  if (!bestCost || !bestTransition) {
    return {
      cost: costToGoNextRow[currentSoCStep] ?? Money.zero(),
      transition: {
        mode: "auto",
        modeParameters: null,
        nextSoCStep: currentSoCStep,
        deltaSoCSteps: 0,
        gridEnergy: Energy.zero(),
        additionalGridCharge: Energy.zero(),
      },
    };
  }

  return {cost: bestCost, transition: bestTransition};
}

function buildMinFutureImportPriceBySlot(slotProfiles: SlotProfile[]): number[] {
  const result = Array.from({length: slotProfiles.length}, () => Number.POSITIVE_INFINITY);
  let runningMin = Number.POSITIVE_INFINITY;
  for (let index = slotProfiles.length - 1; index >= 0; index -= 1) {
    result[index] = runningMin;
    runningMin = Math.min(runningMin, slotProfiles[index]?.priceTotal.eurPerKwh ?? Number.POSITIVE_INFINITY);
  }
  return result;
}

function buildSlotScenario(
  context: SimulationContext,
  profile: SlotProfile,
  currentSoCStep: number,
): BatteryControlSlotScenario {
  return {
    startSocPercent: currentSoCStep * context.socPercentStep,
    startSocStep: currentSoCStep,
    socPercentStep: context.socPercentStep,
    energyPerStepWh: context.energyPerStep.wattHours,
    capacityWh: context.capacity.wattHours,
    minAllowedSocPercent: context.minAllowedSoc.percent,
    minAllowedSoCStep: context.minAllowedSoCStep,
    maxAllowedSocPercent: context.maxChargeSoC.percent,
    maxAllowedSoCStep: context.maxAllowedSoCStep,
    durationHours: profile.duration.hours,
    chemistry: context.chemistry,
    chargeEfficiencyRatio: context.chargeEfficiency.ratio,
    dischargeEfficiencyRatio: context.dischargeEfficiency.ratio,
    chargeAverageCRate: context.chargeAverageCRate,
    dischargeAverageCRate: context.dischargeAverageCRate,
    loadAfterDirectUseWh: profile.loadAfterDirectUse.wattHours,
    availableSolarWh: profile.availableSolar.wattHours,
    baselineGridEnergyWh: profile.baselineGridEnergy.wattHours,
    baselineGridImportWh: profile.baselineGridImport.wattHours,
    gridChargeLimitWh: profile.gridChargeLimit.wattHours,
    solarChargeLimitWh: profile.solarChargeLimit.wattHours,
    totalChargeLimitWh: profile.totalChargeLimit.wattHours,
    dischargeLimitWh: profile.dischargeLimit?.wattHours ?? null,
    allowBatteryExport: context.allowBatteryExport,
  };
}

function shouldPreferTransition(
  candidate: Pick<PolicyTransition, "mode" | "nextSoCStep" | "additionalGridCharge">,
  incumbent: Pick<PolicyTransition, "mode" | "nextSoCStep" | "additionalGridCharge"> | null,
): boolean {
  if (!incumbent) {
    return true;
  }
  if (candidate.nextSoCStep !== incumbent.nextSoCStep) {
    return candidate.nextSoCStep > incumbent.nextSoCStep;
  }
  if (Math.abs(candidate.additionalGridCharge.wattHours - incumbent.additionalGridCharge.wattHours) > EPSILON) {
    return candidate.additionalGridCharge.wattHours < incumbent.additionalGridCharge.wattHours;
  }
  return shouldPreferMode(candidate.mode, incumbent.mode);
}

function shouldRejectLimitUnderCurrentSolar(
  context: SimulationContext,
  profile: SlotProfile,
  currentSoCStep: number,
  mode: OracleEntry["strategy"],
): boolean {
  if (mode !== "limit" && mode !== "hold") {
    return false;
  }

  const solarSurplusWh = profile.availableSolar.subtract(profile.loadAfterDirectUse).wattHours;
  if (solarSurplusWh <= EPSILON) {
    return false;
  }

  if (currentSoCStep >= Math.round(context.maxAllowedSoCStep * LIMIT_HEADROOM_MIN_SOC_FRACTION)) {
    return false;
  }

  const bestFuturePrice = context.minFutureImportPriceBySlot[profile.index] ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(bestFuturePrice)) {
    return true;
  }

  const currentPrice = profile.priceTotal.eurPerKwh;
  return currentPrice - bestFuturePrice < LIMIT_HEADROOM_FUTURE_PRICE_ADVANTAGE_EUR_PER_KWH;
}

function shouldPreferMode(candidate: OracleEntry["strategy"], incumbent: OracleEntry["strategy"] | null): boolean {
  if (!incumbent) {
    return true;
  }
  const rank = new Map<OracleEntry["strategy"], number>([
    ["auto", 4],
    ["charge", 3],
    ["limit", 2],
    ["hold", 1],
  ]);
  return (rank.get(candidate) ?? 0) > (rank.get(incumbent) ?? 0);
}

function normaliseModeParameters(parameters: BatteryControlModeParameters | null): OracleEntry["mode_params"] | undefined {
  if (!parameters) {
    return undefined;
  }
  const modeParams: NonNullable<OracleEntry["mode_params"]> = {};
  if (typeof parameters.floorSocPercent === "number" && Number.isFinite(parameters.floorSocPercent)) {
    modeParams.floor_soc_percent = parameters.floorSocPercent;
  }
  if (typeof parameters.targetSocPercent === "number" && Number.isFinite(parameters.targetSocPercent)) {
    modeParams.target_soc_percent = parameters.targetSocPercent;
  }
  if (typeof parameters.minChargePowerW === "number" && Number.isFinite(parameters.minChargePowerW)) {
    modeParams.min_charge_power_w = parameters.minChargePowerW;
  }
  if (typeof parameters.maxChargePowerW === "number" && Number.isFinite(parameters.maxChargePowerW)) {
    modeParams.max_charge_power_w = parameters.maxChargePowerW;
  }
  return Object.keys(modeParams).length > 0 ? modeParams : undefined;
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
    const nextSoCStep = transition.nextSoCStep;
    const deltaSoCSteps = transition.deltaSoCSteps;
    let strategy = transition.mode;
    const storedEnergyChange = context.energyPerStep.multiply(deltaSoCSteps);
    const importPrice = profile.priceTotal;
    baselineCost = baselineCost.add(computeGridCost(profile.baselineGridEnergy, importPrice, profile.feedInTariff));
    let gridEnergy = transition.gridEnergy;

    if (Math.abs(gridEnergy.kilowattHours) < GRID_CHARGE_STRATEGY_THRESHOLD_KWH) {
      gridEnergy = Energy.zero();
    }

    costTotal = costTotal.add(computeGridCost(gridEnergy, importPrice, profile.feedInTariff));
    gridEnergyTotal = gridEnergyTotal.add(gridEnergy);
    if (gridEnergy.wattHours < 0) {
      feedInTotal = feedInTotal.add(Energy.fromWattHours(Math.abs(gridEnergy.wattHours)));
      feedInProfitTotal = feedInProfitTotal.add(computeGridCost(gridEnergy, importPrice, profile.feedInTariff).negate());
    }
    const additionalGridCharge =
      transition.additionalGridCharge.kilowattHours > GRID_CHARGE_STRATEGY_THRESHOLD_KWH
        ? transition.additionalGridCharge
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
      && context.modeDefinitions.some((mode) => mode.id === "auto")
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
      mode_params: normaliseModeParameters(transition.modeParameters),
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
