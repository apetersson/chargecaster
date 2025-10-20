import type { OracleEntry, PriceSlot, SimulationConfig } from "@chargecaster/domain";

const SOC_STEPS = 100;
const EPSILON = 1e-9;
const WATTS_PER_KW = 1000;
const GRID_CHARGE_STRATEGY_THRESHOLD_KWH = 0.05;
const HOLD_ENERGY_THRESHOLD_KWH = 0.02;

export interface SimulationOptions {
  solarGenerationKwhPerSlot?: number[];
  pvDirectUseRatio?: number;
  feedInTariffEurPerKwh?: number;
  allowBatteryExport?: boolean;
  allowGridChargeFromGrid?: boolean;
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
  average_price_eur_per_kwh: number;
  forecast_samples: number;
  forecast_hours: number;
  oracle_entries: OracleEntry[];
  timestamp: string;
}

export function clampRatio(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  if (numeric <= 0) {
    return 0;
  }
  if (numeric >= 1) {
    return 1;
  }
  return numeric;
}

export function gridFee(cfg: SimulationConfig): number {
  const value = cfg.price.grid_fee_eur_per_kwh ?? 0;
  return Number(value) || 0;
}

function computeSlotCost(gridEnergyKwh: number, importPrice: number, feedInTariff: number): number {
  if (!Number.isFinite(gridEnergyKwh) || Number.isNaN(gridEnergyKwh)) {
    return 0;
  }
  const priceImport = Number.isFinite(importPrice) ? importPrice : 0;
  const priceFeedIn = Number.isFinite(feedInTariff) ? feedInTariff : 0;
  if (gridEnergyKwh >= 0) {
    return priceImport * gridEnergyKwh;
  }
  return priceFeedIn * gridEnergyKwh;
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
  durationHours: number;
  loadEnergyKwh: number;
  solarGenerationKwh: number;
  directUseEnergyKwh: number;
  loadAfterDirectUseKwh: number;
  availableSolarKwh: number;
  priceTotal: number;
  baselineGridEnergyKwh: number;
  baselineGridImportKwh: number;
  gridChargeLimitKwh: number;
  solarChargeLimitKwh: number;
  totalChargeLimitKwh: number;
  dischargeLimitKwh: number;
}

interface SimulationContext {
  cfg: SimulationConfig;
  slots: PriceSlot[];
  slotProfiles: SlotProfile[];
  socPercentStep: number;
  energyPerStepKwh: number;
  numSoCStates: number;
  maxAllowedSoCStep: number;
  minAllowedSoCStep: number;
  horizon: number;
  avgPriceEurPerKwh: number;
  totalDurationHours: number;
  currentSoCStep: number;
  currentSoCPercent: number;
  minAllowedSocPercent: number;
  maxChargeSoC: number;
  networkTariffEurPerKwh: number;
  houseLoadW: number;
  capacityKwh: number;
  maxChargePowerW: number;
  maxSolarChargePowerW: number | null;
  maxDischargePowerW: number | null;
  directUseRatio: number;
  feedInTariff: number;
  allowBatteryExport: boolean;
  allowGridChargeFromGrid: boolean;
  solarGenerationPerSlotKwh: number[];
}

interface DynamicProgrammingResult {
  policy: PolicyTransition[][];
}

interface RolloutResult {
  socPathSteps: number[];
  costTotal: number;
  baselineCost: number;
  gridEnergyTotalKwh: number;
  gridChargeTotalKwh: number;
  oracleEntries: OracleEntry[];
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

  const {battery, price, logic, solar} = cfg;

  const capacityKwh = Number(battery.capacity_kwh ?? 0);
  if (!(capacityKwh > 0)) {
    throw new Error("battery.capacity_kwh must be > 0");
  }

  const normalizedOptions = {
    solarGenerationPerSlotKwh: options.solarGenerationKwhPerSlot ?? [],
    directUseRatio: clampRatio(options.pvDirectUseRatio ?? solar?.direct_use_ratio ?? 0),
    feedInTariff: Math.max(
      0,
      Number(options.feedInTariffEurPerKwh ?? price.feed_in_tariff_eur_per_kwh ?? 0),
    ),
    allowBatteryExport:
      typeof options.allowBatteryExport === "boolean"
        ? options.allowBatteryExport
        : logic.allow_battery_export ?? true,
    allowGridChargeFromGrid:
      typeof options.allowGridChargeFromGrid === "boolean" ? options.allowGridChargeFromGrid : true,
  } as const;

  const maxChargePowerW = Math.max(0, Number(battery.max_charge_power_w ?? 0));
  const maxSolarChargePowerW = battery.max_charge_power_solar_w != null
    ? Math.max(0, Number(battery.max_charge_power_solar_w))
    : null;
  const maxDischargePowerW = battery.max_discharge_power_w != null
    ? Math.max(0, Number(battery.max_discharge_power_w))
    : null;
  const networkTariffEurPerKwh = gridFee(cfg);
  const houseLoadW = logic.house_load_w ?? 1200;

  let currentSoCPercent = Number(liveState.battery_soc ?? 50);
  if (Number.isNaN(currentSoCPercent)) {
    currentSoCPercent = 50;
  }
  currentSoCPercent = Math.min(100, Math.max(0, currentSoCPercent));

  const socPercentStep = 100 / SOC_STEPS;
  const energyPerStepKwh = capacityKwh / SOC_STEPS;
  const minAllowedSocPercent = (() => {
    const v = battery.auto_mode_floor_soc;
    if (typeof v === "number" && Number.isFinite(v)) {
      return Math.min(Math.max(v, 0), 100);
    }
    return 0;
  })();
  const maxChargeSoC = (() => {
    const v = battery.max_charge_soc_percent;
    if (typeof v === "number" && Number.isFinite(v)) {
      return Math.min(Math.max(v, 0), 100);
    }
    return 100;
  })();

  let minAllowedSoCStep = Math.max(0, Math.ceil(minAllowedSocPercent / socPercentStep - EPSILON));
  const maxPossibleStep = Math.round(100 / socPercentStep);
  if (minAllowedSoCStep > maxPossibleStep) {
    minAllowedSoCStep = maxPossibleStep;
  }
  minAllowedSoCStep = Math.min(minAllowedSoCStep, Math.round(maxChargeSoC / socPercentStep));

  const totalDurationHours = slots.reduce((acc, item) => acc + item.durationHours, 0);
  if (totalDurationHours <= 0) {
    throw new Error("price forecast has zero duration");
  }

  const avgPriceEurPerKwh =
    slots.reduce(
      (acc, slot) => acc + (slot.price + networkTariffEurPerKwh) * slot.durationHours,
      0,
    ) / totalDurationHours;

  const numSoCStates = SOC_STEPS + 1;
  const maxAllowedSoCStep = Math.round(maxChargeSoC / socPercentStep);
  const horizon = slots.length;
  const currentSoCStep = Math.max(
    0,
    Math.min(numSoCStates - 1, Math.round(currentSoCPercent / socPercentStep)),
  );

  const slotProfiles = buildSlotProfiles({
    slots,
    directUseRatio: normalizedOptions.directUseRatio,
    solarGenerationPerSlotKwh: normalizedOptions.solarGenerationPerSlotKwh,
    houseLoadW,
    networkTariffEurPerKwh,
    allowGridChargeFromGrid: normalizedOptions.allowGridChargeFromGrid,
    maxChargePowerW,
    maxSolarChargePowerW,
    maxDischargePowerW,
  });

  return {
    cfg,
    slots,
    slotProfiles,
    socPercentStep,
    energyPerStepKwh,
    numSoCStates,
    maxAllowedSoCStep,
    minAllowedSoCStep,
    horizon,
    avgPriceEurPerKwh,
    totalDurationHours,
    currentSoCStep,
    currentSoCPercent,
    minAllowedSocPercent,
    maxChargeSoC,
    networkTariffEurPerKwh,
    houseLoadW,
    capacityKwh,
    maxChargePowerW,
    maxSolarChargePowerW,
    maxDischargePowerW,
    directUseRatio: normalizedOptions.directUseRatio,
    feedInTariff: normalizedOptions.feedInTariff,
    allowBatteryExport: normalizedOptions.allowBatteryExport,
    allowGridChargeFromGrid: normalizedOptions.allowGridChargeFromGrid,
    solarGenerationPerSlotKwh: normalizedOptions.solarGenerationPerSlotKwh,
  };
}

function buildSlotProfiles(params: {
  slots: PriceSlot[];
  directUseRatio: number;
  solarGenerationPerSlotKwh: number[];
  houseLoadW: number;
  networkTariffEurPerKwh: number;
  allowGridChargeFromGrid: boolean;
  maxChargePowerW: number;
  maxSolarChargePowerW: number | null;
  maxDischargePowerW: number | null;
}): SlotProfile[] {
  return params.slots.map((slot, index) => {
    const durationHours = slot.durationHours;
    const loadEnergyKwh = (params.houseLoadW / WATTS_PER_KW) * durationHours;
    const solarGenerationKwh = params.solarGenerationPerSlotKwh[index] ?? 0;
    const directTargetKwh = Math.max(0, solarGenerationKwh * params.directUseRatio);
    const directUseEnergyKwh = Math.min(loadEnergyKwh, directTargetKwh);
    const loadAfterDirectUseKwh = loadEnergyKwh - directUseEnergyKwh;
    const availableSolarKwh = Math.max(0, solarGenerationKwh - directUseEnergyKwh);
    const priceTotal = slot.price + params.networkTariffEurPerKwh;
    const baselineGridEnergyKwh = loadAfterDirectUseKwh - availableSolarKwh;
    const baselineGridImportKwh = Math.max(0, baselineGridEnergyKwh);
    const gridChargeLimitKwh = params.allowGridChargeFromGrid && params.maxChargePowerW > 0
      ? (params.maxChargePowerW / WATTS_PER_KW) * durationHours
      : 0;
    const solarChargeLimitKwh = availableSolarKwh <= 0
      ? 0
      : params.maxSolarChargePowerW != null
        ? Math.min(
          availableSolarKwh,
          (params.maxSolarChargePowerW / WATTS_PER_KW) * durationHours,
        )
        : availableSolarKwh;
    const dischargeLimitKwh = params.maxDischargePowerW == null
      ? Number.POSITIVE_INFINITY
      : (params.maxDischargePowerW / WATTS_PER_KW) * durationHours;

    return {
      index,
      slot,
      durationHours,
      loadEnergyKwh,
      solarGenerationKwh,
      directUseEnergyKwh,
      loadAfterDirectUseKwh,
      availableSolarKwh,
      priceTotal,
      baselineGridEnergyKwh,
      baselineGridImportKwh,
      gridChargeLimitKwh,
      solarChargeLimitKwh,
      totalChargeLimitKwh: gridChargeLimitKwh + solarChargeLimitKwh,
      dischargeLimitKwh,
    } satisfies SlotProfile;
  });
}

function runBackwardPass(context: SimulationContext): DynamicProgrammingResult {
  const {horizon, numSoCStates, avgPriceEurPerKwh, energyPerStepKwh, slotProfiles} = context;
  // costToGoTable[slotIndex][stateIndex] tracks the minimum cumulative cost from that slot forward
  const costToGoTable: number[][] = Array.from({length: horizon + 1}, () =>
    Array.from({length: numSoCStates}, () => Number.POSITIVE_INFINITY),
  );
  const policy: PolicyTransition[][] = Array.from({length: horizon}, () =>
    Array.from({length: numSoCStates}, () => ({
      kind: TransitionKind.Hold,
      nextSoCStep: 0,
      deltaSoCSteps: 0,
    })),
  );

  for (let socStep = 0; socStep < numSoCStates; socStep += 1) {
    const energyKwh = socStep * energyPerStepKwh;
    costToGoTable[horizon][socStep] = -avgPriceEurPerKwh * energyKwh;
  }

  // Walk backwards through the forecast horizon so each slot inherits the optimal future cost profile
  for (let idx = horizon - 1; idx >= 0; idx -= 1) {
    const profile = slotProfiles[idx];
    const nextRow = costToGoTable[idx + 1];
    for (let socStep = 0; socStep < numSoCStates; socStep += 1) {
      const evaluation = evaluateStateTransitions(context, profile, socStep, nextRow);
      costToGoTable[idx][socStep] = evaluation.cost;
      policy[idx][socStep] = evaluation.transition;
    }
  }

  return {policy};
}

function evaluateStateTransitions(
  context: SimulationContext,
  profile: SlotProfile,
  currentSoCStep: number,
  costToGoNextRow: number[],
): { cost: number; transition: PolicyTransition } {
  // Evaluate every feasible delta in SoC for this slot and pair it with the downstream cost-to-go signal
  const {
    energyPerStepKwh,
    numSoCStates,
    maxAllowedSoCStep,
    minAllowedSoCStep,
    allowBatteryExport,
    feedInTariff,
  } = context;
  const {
    totalChargeLimitKwh,
    dischargeLimitKwh,
    loadAfterDirectUseKwh,
    availableSolarKwh,
    gridChargeLimitKwh,
    solarChargeLimitKwh,
    baselineGridEnergyKwh,
    baselineGridImportKwh,
    priceTotal,
  } = profile;

  let maxChargeSteps = numSoCStates - 1 - currentSoCStep;
  if (totalChargeLimitKwh > 0) {
    maxChargeSteps = Math.min(
      maxChargeSteps,
      Math.floor(totalChargeLimitKwh / energyPerStepKwh + EPSILON),
    );
  } else {
    maxChargeSteps = Math.min(maxChargeSteps, 0);
  }
  const upLimit = Math.min(maxChargeSteps, numSoCStates - 1 - currentSoCStep);

  let maxDischargeStepsByPower = currentSoCStep;
  if (Number.isFinite(dischargeLimitKwh)) {
    maxDischargeStepsByPower = Math.min(
      maxDischargeStepsByPower,
      Math.floor(dischargeLimitKwh / energyPerStepKwh + EPSILON),
    );
  }
  const allowedDischargeSteps = Math.max(0, currentSoCStep - minAllowedSoCStep);
  const downLimit = Math.max(0, Math.min(maxDischargeStepsByPower, allowedDischargeSteps));

  let bestCost = Number.POSITIVE_INFINITY;
  let bestTransition: PolicyTransition | null = null;

  for (let deltaSoCSteps = -downLimit; deltaSoCSteps <= upLimit; deltaSoCSteps += 1) {
    const nextSoCStep = currentSoCStep + deltaSoCSteps;
    const energyChangeKwh = deltaSoCSteps * energyPerStepKwh;
    const gridEnergyKwh = loadAfterDirectUseKwh + energyChangeKwh - availableSolarKwh;

    if (nextSoCStep < minAllowedSoCStep) {
      continue;
    }

    if (
      !pvCanExportUnderState(context, profile, currentSoCStep, energyChangeKwh, gridEnergyKwh)
    ) {
      continue;
    }

    if (!allowBatteryExport) {
      const minGridEnergyKwh = baselineGridEnergyKwh < 0 ? baselineGridEnergyKwh : 0;
      if (gridEnergyKwh < minGridEnergyKwh - EPSILON) {
        continue;
      }
    }

    if (energyChangeKwh > 0) {
      const gridImportKwh = Math.max(0, gridEnergyKwh);
      const additionalGridChargeKwh = Math.max(0, gridImportKwh - baselineGridImportKwh);

      if (nextSoCStep > maxAllowedSoCStep && additionalGridChargeKwh > EPSILON) {
        continue;
      }

      const solarPossibleKwh = Math.min(energyChangeKwh, solarChargeLimitKwh, Math.max(0, availableSolarKwh));
      const maxGridNeededKwh = Math.max(0, energyChangeKwh - solarPossibleKwh);
      if (additionalGridChargeKwh > gridChargeLimitKwh + EPSILON) {
        continue;
      }
      if (additionalGridChargeKwh > maxGridNeededKwh + EPSILON) {
        continue;
      }
      const solarChargingKwh = Math.max(0, energyChangeKwh - additionalGridChargeKwh);
      if (solarChargingKwh > solarChargeLimitKwh + EPSILON) {
        continue;
      }
    }

    const slotCost = computeSlotCost(gridEnergyKwh, priceTotal, feedInTariff);
    const totalCost = slotCost + costToGoNextRow[nextSoCStep];
    if (totalCost < bestCost) {
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

  if (!Number.isFinite(bestCost) || !bestTransition) {
    return {
      cost: costToGoNextRow[currentSoCStep],
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
  energyChangeKwh: number,
  gridEnergyKwh: number,
): boolean {
  if (gridEnergyKwh >= 0) {
    return true;
  }
  const socStepsToFull = Math.max(0, (context.numSoCStates - 1) - socStep);
  if (socStepsToFull <= 0) {
    return true;
  }
  const socHeadroomKwh = socStepsToFull * context.energyPerStepKwh;
  const requiredToAvoidExportKwh = Math.max(0, profile.availableSolarKwh - profile.loadAfterDirectUseKwh);
  const requiredChargeKwh = Math.min(requiredToAvoidExportKwh, profile.solarChargeLimitKwh, socHeadroomKwh);
  return !(requiredChargeKwh > EPSILON && energyChangeKwh + EPSILON < requiredChargeKwh);

}

function buildSimulationOutput(
  context: SimulationContext,
  policy: PolicyTransition[][],
): SimulationOutput {
  const rollout = runForwardPass(context, policy);
  const {socPathSteps, costTotal, baselineCost, gridEnergyTotalKwh, gridChargeTotalKwh, oracleEntries} = rollout;

  const finalEnergy = socPathSteps[socPathSteps.length - 1] * context.energyPerStepKwh;
  const adjustedCost = costTotal - context.avgPriceEurPerKwh * finalEnergy;
  const adjustedBaseline = baselineCost - context.avgPriceEurPerKwh * finalEnergy;
  const projectedSavings = adjustedBaseline - adjustedCost;
  const projectedGridPowerW = context.totalDurationHours > 0
    ? (gridEnergyTotalKwh / context.totalDurationHours) * WATTS_PER_KW
    : 0;

  const shouldChargeFromGrid = gridChargeTotalKwh > 0.001;
  const hasOracleEntries = oracleEntries.length > 0;
  const firstEntry = hasOracleEntries ? oracleEntries[0] : null;
  const firstTarget = firstEntry
    ? firstEntry.end_soc_percent ?? firstEntry.target_soc_percent ?? null
    : null;
  const lastEntry = hasOracleEntries ? oracleEntries[oracleEntries.length - 1] : null;
  const finalTarget = lastEntry
    ? lastEntry.end_soc_percent ?? lastEntry.target_soc_percent ?? null
    : null;
  const recommendedTargetRaw = shouldChargeFromGrid ? context.maxChargeSoC : (finalTarget ?? context.maxChargeSoC);
  const recommendedTarget = Math.max(
    context.minAllowedSocPercent,
    Math.min(recommendedTargetRaw, context.maxChargeSoC),
  );
  const nextStepSocPercentRaw = firstTarget ?? context.currentSoCStep * context.socPercentStep;
  const nextStepSocPercent = Math.max(context.minAllowedSocPercent, nextStepSocPercentRaw);

  return {
    initial_soc_percent: Math.max(context.minAllowedSocPercent, context.currentSoCStep * context.socPercentStep),
    next_step_soc_percent: nextStepSocPercent,
    recommended_soc_percent: recommendedTarget,
    recommended_final_soc_percent: recommendedTarget,
    simulation_runs: SOC_STEPS,
    projected_cost_eur: adjustedCost,
    baseline_cost_eur: adjustedBaseline,
    projected_savings_eur: projectedSavings,
    projected_grid_power_w: projectedGridPowerW,
    average_price_eur_per_kwh: context.avgPriceEurPerKwh,
    forecast_samples: context.slots.length,
    forecast_hours: context.totalDurationHours,
    oracle_entries: oracleEntries,
    timestamp: new Date().toISOString(),
  };
}

function runForwardPass(context: SimulationContext, policy: PolicyTransition[][]): RolloutResult {
  const {energyPerStepKwh, horizon, slotProfiles, feedInTariff} = context;
  const socPathSteps: number[] = [context.currentSoCStep];
  const oracleEntries: OracleEntry[] = [];
  let costTotal = 0;
  let baselineCost = 0;
  let gridEnergyTotalKwh = 0;
  let gridChargeTotalKwh = 0;
  let socStepIter = context.currentSoCStep;

  for (let idx = 0; idx < horizon; idx += 1) {
    const profile = slotProfiles[idx];
    const transition = policy[idx][socStepIter];
    let nextSoCStep = transition.nextSoCStep;
    let deltaSoCSteps = transition.deltaSoCSteps;
    let energyChangeKwh = deltaSoCSteps * energyPerStepKwh;
    const importPrice = profile.priceTotal;
    baselineCost += computeSlotCost(profile.baselineGridEnergyKwh, importPrice, feedInTariff);
    let gridEnergyKwh = profile.loadAfterDirectUseKwh + energyChangeKwh - profile.availableSolarKwh;

    // During rollout we adapt transitions again if solar surplus would otherwise force an export
    ({nextSoCStep, deltaSoCSteps, energyChangeKwh, gridEnergyKwh} = adjustForPvExportDuringRollout(
      context,
      profile,
      socStepIter,
      {nextSoCStep, deltaSoCSteps, energyChangeKwh, gridEnergyKwh},
    ));

    if (nextSoCStep < context.minAllowedSoCStep) {
      nextSoCStep = context.minAllowedSoCStep;
      deltaSoCSteps = nextSoCStep - socStepIter;
      energyChangeKwh = deltaSoCSteps * context.energyPerStepKwh;
      gridEnergyKwh = profile.loadAfterDirectUseKwh + energyChangeKwh - profile.availableSolarKwh;
    }

    if (Math.abs(gridEnergyKwh) < GRID_CHARGE_STRATEGY_THRESHOLD_KWH) {
      gridEnergyKwh = 0;
    }

    costTotal += computeSlotCost(gridEnergyKwh, importPrice, feedInTariff);
    gridEnergyTotalKwh += gridEnergyKwh;
    const baselineGridImportKwh = profile.baselineGridImportKwh;
    const gridImportKwh = Math.max(0, gridEnergyKwh);
    const additionalGridChargeKwhRaw = energyChangeKwh > 0 ? Math.max(0, gridImportKwh - baselineGridImportKwh) : 0;
    const additionalGridChargeKwh =
      additionalGridChargeKwhRaw > GRID_CHARGE_STRATEGY_THRESHOLD_KWH ? additionalGridChargeKwhRaw : 0;
    if (additionalGridChargeKwh > 0) {
      gridChargeTotalKwh += additionalGridChargeKwh;
    }
    socPathSteps.push(nextSoCStep);

    const eraId =
      typeof profile.slot.eraId === "string" && profile.slot.eraId.length > 0
        ? profile.slot.eraId
        : profile.slot.start.toISOString();
    const startSocPercent = socStepIter * context.socPercentStep;
    const endSocPercent = nextSoCStep * context.socPercentStep;
    const normalizedGridEnergyWh = Number.isFinite(gridEnergyKwh) ? gridEnergyKwh * WATTS_PER_KW : null;
    const isHoldTransition =
      Math.abs(deltaSoCSteps) === 0 &&
      Math.abs(energyChangeKwh) <= HOLD_ENERGY_THRESHOLD_KWH &&
      additionalGridChargeKwh <= GRID_CHARGE_STRATEGY_THRESHOLD_KWH;
    const strategy: OracleEntry["strategy"] = additionalGridChargeKwh > 0
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

  return {socPathSteps, costTotal, baselineCost, gridEnergyTotalKwh, gridChargeTotalKwh, oracleEntries};
}

function adjustForPvExportDuringRollout(
  context: SimulationContext,
  profile: SlotProfile,
  socStepIter: number,
  input: {
    nextSoCStep: number;
    deltaSoCSteps: number;
    energyChangeKwh: number;
    gridEnergyKwh: number;
  },
): {
  nextSoCStep: number;
  deltaSoCSteps: number;
  energyChangeKwh: number;
  gridEnergyKwh: number;
} {
  let {nextSoCStep, deltaSoCSteps, energyChangeKwh, gridEnergyKwh} = input;
  // If the planned transition would export PV to the grid, opportunistically charge further instead
  if (gridEnergyKwh < 0) {
    const socStepsToFull = Math.max(0, (context.numSoCStates - 1) - socStepIter);
    const socHeadroomKwh = socStepsToFull * context.energyPerStepKwh;
    const requiredToAvoidExportKwh = Math.max(0, profile.availableSolarKwh - profile.loadAfterDirectUseKwh);
    const requiredChargeKwh = Math.min(requiredToAvoidExportKwh, profile.solarChargeLimitKwh, socHeadroomKwh);
    if (requiredChargeKwh > energyChangeKwh + EPSILON && socHeadroomKwh > EPSILON) {
      const extraKwh = Math.min(requiredChargeKwh - energyChangeKwh, socHeadroomKwh);
      const extraSteps = Math.max(0, Math.ceil(extraKwh / context.energyPerStepKwh - EPSILON));
      if (extraSteps > 0) {
        nextSoCStep = Math.min(context.numSoCStates - 1, nextSoCStep + extraSteps);
        deltaSoCSteps = nextSoCStep - socStepIter;
        energyChangeKwh = deltaSoCSteps * context.energyPerStepKwh;
        gridEnergyKwh = profile.loadAfterDirectUseKwh + energyChangeKwh - profile.availableSolarKwh;
      }
      if (gridEnergyKwh < -EPSILON) {
        const targetSteps = Math.max(0, Math.ceil(requiredChargeKwh / context.energyPerStepKwh - EPSILON));
        if (targetSteps > 0) {
          nextSoCStep = Math.min(context.numSoCStates - 1, socStepIter + targetSteps);
          deltaSoCSteps = nextSoCStep - socStepIter;
          energyChangeKwh = deltaSoCSteps * context.energyPerStepKwh;
          gridEnergyKwh = profile.loadAfterDirectUseKwh + energyChangeKwh - profile.availableSolarKwh;
        }
      }
    }
  }
  return {nextSoCStep, deltaSoCSteps, energyChangeKwh, gridEnergyKwh};
}
