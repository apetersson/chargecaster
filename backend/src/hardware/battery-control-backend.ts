import type { BatteryChemistry, BatteryControlMode, SimulationConfig } from "@chargecaster/domain";
import { Duration, Energy, Percentage } from "@chargecaster/domain";
import { resolveTransitionEfficiencies } from "../simulation/battery-efficiency-curve";

export const BATTERY_CONTROL_BACKEND = Symbol("BATTERY_CONTROL_BACKEND");

export type { BatteryControlMode };

export interface BatteryControlWindow {
  startTimestamp?: string | null;
  untilTimestamp?: string | null;
}

export type BatteryControlCommand =
  | {charge: BatteryControlWindow & {targetSocPercent?: number | null; minChargePowerW?: number | null}}
  | "charge"
  | "auto"
  | "limit"
  | {auto: {floorSocPercent?: number | null}}
  | {limit: BatteryControlWindow & {maxSocPercent?: number | null; maxChargePowerW?: number | null}}
  | {hold: {minSocPercent: number; observedSocPercent?: number | null}};

export interface BatteryControlApplyResult {
  errorMessage: string | null;
}

export interface BatteryControlSocRange {
  minPercent: number;
  maxPercent: number;
  stepPercent: number | null;
}

export interface BatteryControlPowerRange {
  minPowerW: number;
  maxPowerW: number | null;
  stepPowerW: number | null;
  supportsZeroPower: boolean;
}

export interface BatteryControlModeDefinition {
  id: BatteryControlMode;
  allowsAutomaticSolarCharging?: boolean;
  floorSocRange?: BatteryControlSocRange | null;
  targetSocRange?: BatteryControlSocRange | null;
  maxSocRange?: BatteryControlSocRange | null;
  minChargePowerRange?: (BatteryControlPowerRange & {supportsWindows: boolean; fixedPowerW?: number | null}) | null;
  maxChargePowerRange?: (BatteryControlPowerRange & {supportsWindows: boolean}) | null;
  tieBreakPriority?: number;
  enumerateParameters(scenario: BatteryControlSlotScenario): BatteryControlModeParameters[];
  applySlotScenario(scenario: BatteryControlSlotScenario, parameters: BatteryControlModeParameters): BatteryControlSlotOutcome | null;
  buildCommandFromSnapshot?(snapshot: BatteryControlSnapshotLike): BatteryControlCommand | null;
  shouldRejectOutcome?(context: BatteryControlModeRejectionContext): boolean;
  resolveOracleStrategy?(transition: Pick<BatteryControlSlotOutcome, "mode" | "deltaSoCSteps">, availableModes: Set<BatteryControlMode>): BatteryControlMode;
  reverseApplySlotScenario?(scenario: BatteryControlSlotScenario, parameters: BatteryControlModeParameters): BatteryControlSlotOutcome[] | null;
}

export interface BatteryControlModeParameters {
  floorSocPercent?: number | null;
  targetSocPercent?: number | null;
  minSocPercent?: number | null;
  maxSocPercent?: number | null;
  minChargePowerW?: number | null;
  maxChargePowerW?: number | null;
}

export interface BatteryControlSlotScenario {
  startSocPercent: number;
  startSocStep: number;
  socPercentStep: number;
  energyPerStepWh: number;
  capacityWh: number;
  minAllowedSocPercent: number;
  minAllowedSoCStep: number;
  maxAllowedSocPercent: number;
  maxAllowedSoCStep: number;
  durationHours: number;
  chemistry: BatteryChemistry | null;
  chargeEfficiencyRatio: number;
  dischargeEfficiencyRatio: number;
  chargeAverageCRate: number;
  dischargeAverageCRate: number;
  loadAfterDirectUseWh: number;
  availableSolarWh: number;
  baselineGridEnergyWh: number;
  baselineGridImportWh: number;
  gridChargeLimitWh: number;
  solarChargeLimitWh: number;
  totalChargeLimitWh: number;
  dischargeLimitWh: number | null;
  allowBatteryExport: boolean;
}

export interface BatteryControlSlotOutcome {
  mode: BatteryControlMode;
  parameters: BatteryControlModeParameters;
  nextSoCStep: number;
  endSocPercent: number;
  deltaSoCSteps: number;
  storedEnergyWh: number;
  batteryEnergyAtBusWh: number;
  gridEnergyWh: number;
  additionalGridChargeWh: number;
}

export interface BatteryControlCapabilities {
  backendId: string;
  modes: BatteryControlModeDefinition[];
  scheduleConstraints: {
    minWindowMinutes: number | null;
    maxWindows: number | null;
  };
}

export interface BatteryControlBackend {
  getCapabilities(): BatteryControlCapabilities;
  applyOptimization(command: BatteryControlCommand): Promise<BatteryControlApplyResult>;
}

export interface BatteryOptimisationConstraints {
  availableModes: BatteryControlMode[];
  availableModeDefinitions: BatteryControlModeDefinition[];
  allowGridChargeFromGrid: boolean;
  canPreventAutomaticSolarCharging: boolean;
}

export interface BatteryControlSnapshotOracleEntryLike {
  era_id?: string | null;
  strategy?: BatteryControlMode | null;
  start_soc_percent?: number | null;
  end_soc_percent?: number | null;
  target_soc_percent?: number | null;
  mode_params?: {
    floor_soc_percent?: number | null;
    target_soc_percent?: number | null;
    min_soc_percent?: number | null;
    max_soc_percent?: number | null;
    min_charge_power_w?: number | null;
    max_charge_power_w?: number | null;
  } | null;
}

export interface BatteryControlSnapshotForecastEraLike {
  era_id?: string | null;
  end?: string | null;
}

export interface BatteryControlSnapshotLike {
  current_mode?: BatteryControlMode | null;
  current_soc_percent?: Percentage | number | null;
  next_step_soc_percent?: Percentage | number | null;
  oracle_entries?: BatteryControlSnapshotOracleEntryLike[] | null;
  forecast_eras?: BatteryControlSnapshotForecastEraLike[] | null;
}

export interface BatteryControlModeRejectionContext {
  scenario: BatteryControlSlotScenario;
  outcome: BatteryControlSlotOutcome;
  currentPriceEurPerKwh: number;
  minFutureImportPriceEurPerKwh: number | null;
}

const EPSILON = 1e-9;
const LIMIT_HEADROOM_FUTURE_PRICE_ADVANTAGE_EUR_PER_KWH = 0.05;
const LIMIT_HEADROOM_MIN_SOC_FRACTION = 0.5;

export function deriveBatteryOptimisationConstraints(
  capabilities?: BatteryControlCapabilities | null,
  configuredModes?: BatteryControlMode[] | null,
): BatteryOptimisationConstraints {
  const capabilityModeIds = new Set(
    capabilities?.modes
      ?.map((mode) => mode.id)
      .filter((mode): mode is BatteryControlMode => typeof mode === "string" && mode.length > 0)
      ?? [],
  );
  const configuredModeSet = new Set(
    Array.isArray(configuredModes)
      ? configuredModes.filter((mode): mode is BatteryControlMode => typeof mode === "string" && mode.length > 0)
      : [],
  );

  const availableModes = (["charge", "auto", "hold", "limit"] as const).filter((mode) => {
    if (capabilityModeIds.size > 0 && !capabilityModeIds.has(mode)) {
      return false;
    }
    if (configuredModeSet.size > 0 && !configuredModeSet.has(mode)) {
      return false;
    }
    return true;
  });

  return {
    availableModes,
    availableModeDefinitions: capabilities?.modes?.filter((mode) => availableModes.includes(mode.id)) ?? buildGenericBatteryControlCapabilities().modes,
    allowGridChargeFromGrid: availableModes.includes("charge"),
    canPreventAutomaticSolarCharging: (
      capabilities?.modes?.filter((mode) => availableModes.includes(mode.id))
      ?? buildGenericBatteryControlCapabilities().modes
    ).some((mode) => mode.allowsAutomaticSolarCharging === false),
  };
}

export function clampSimulationConfigToBatteryCapabilities(
  config: SimulationConfig,
  capabilities?: BatteryControlCapabilities | null,
): SimulationConfig {
  if (!capabilities) {
    return config;
  }

  const autoMode = getBatteryControlModeDefinition(capabilities, "auto");
  const chargeMode = getBatteryControlModeDefinition(capabilities, "charge");

  const floorSoc = clampToSocRange(config.battery.auto_mode_floor_soc ?? null, autoMode?.floorSocRange ?? null);
  const maxChargeSocCandidate = clampToSocRange(config.battery.max_charge_soc_percent ?? null, chargeMode?.targetSocRange ?? null);
  const maxChargeSoc = maxChargeSocCandidate == null
    ? floorSoc
    : floorSoc == null
      ? maxChargeSocCandidate
      : Math.max(floorSoc, maxChargeSocCandidate);

  const maxChargePowerCandidate = clampToPowerRange(
    config.battery.max_charge_power_w ?? null,
    chargeMode?.minChargePowerRange ?? null,
  );
  const maxChargePower = maxChargePowerCandidate ?? config.battery.max_charge_power_w ?? null;

  return {
    ...config,
    battery: {
      ...config.battery,
      auto_mode_floor_soc: floorSoc ?? config.battery.auto_mode_floor_soc ?? null,
      max_charge_soc_percent: maxChargeSoc ?? config.battery.max_charge_soc_percent ?? null,
      max_charge_power_w: maxChargePower,
    },
  };
}

export function getBatteryControlModeDefinition(
  capabilities: BatteryControlCapabilities | null | undefined,
  id: BatteryControlMode,
): BatteryControlModeDefinition | null {
  if (!capabilities) {
    return null;
  }
  return capabilities.modes.find((mode) => mode.id === id) ?? null;
}

export function buildGenericBatteryControlCapabilities(): BatteryControlCapabilities {
  return {
    backendId: "generic-test-backend",
    modes: [
      createAutoModeDefinition({
        floorSocRange: {minPercent: 0, maxPercent: 100, stepPercent: 1},
      }),
      createHoldModeDefinition({
        floorSocRange: {minPercent: 0, maxPercent: 100, stepPercent: 1},
        targetSocRange: {minPercent: 0, maxPercent: 100, stepPercent: 1},
      }),
      createLimitModeDefinition({
        maxSocRange: {minPercent: 0, maxPercent: 100, stepPercent: 1},
        maxChargePowerRange: {
          minPowerW: 0,
          maxPowerW: null,
          stepPowerW: 1,
          supportsZeroPower: true,
          supportsWindows: true,
        },
      }),
      createChargeModeDefinition({
        targetSocRange: {minPercent: 0, maxPercent: 100, stepPercent: 1},
        minChargePowerRange: {
          minPowerW: 0,
          maxPowerW: null,
          stepPowerW: 1,
          supportsZeroPower: true,
          supportsWindows: true,
          fixedPowerW: null,
        },
      }),
    ],
    scheduleConstraints: {
      minWindowMinutes: null,
      maxWindows: null,
    },
  };
}

export function createAutoModeDefinition(definition: {
  floorSocRange: BatteryControlSocRange;
}): BatteryControlModeDefinition {
  return {
    id: "auto",
    allowsAutomaticSolarCharging: true,
    floorSocRange: definition.floorSocRange,
    tieBreakPriority: 4,
    enumerateParameters(scenario) {
      return [{floorSocPercent: clampScenarioPercent(scenario.minAllowedSocPercent, definition.floorSocRange)}];
    },
    applySlotScenario(scenario, parameters) {
      const floorPercent = clampScenarioPercent(
        parameters.floorSocPercent ?? scenario.minAllowedSocPercent,
        definition.floorSocRange,
      );
      return applyAutoScenario(scenario, floorPercent);
    },
    buildCommandFromSnapshot(snapshot) {
      const floor = clampToSocRange(extractAutoFloor(snapshot), definition.floorSocRange);
      return floor != null ? {auto: {floorSocPercent: floor}} : "auto";
    },
  };
}

export function createHoldModeDefinition(definition: {
  floorSocRange: BatteryControlSocRange;
  targetSocRange: BatteryControlSocRange;
}): BatteryControlModeDefinition {
  return {
    id: "hold",
    allowsAutomaticSolarCharging: true,
    floorSocRange: definition.floorSocRange,
    targetSocRange: definition.targetSocRange,
    tieBreakPriority: 2,
    enumerateParameters(scenario) {
      const targetPercent = clampScenarioPercent(scenario.startSocPercent, definition.targetSocRange);
      const floorPercent = clampScenarioPercent(Math.min(targetPercent, scenario.startSocPercent), definition.floorSocRange);
      return [{targetSocPercent: targetPercent, floorSocPercent: floorPercent}];
    },
    applySlotScenario(scenario, parameters) {
      const minimumPercent = clampScenarioPercent(
        parameters.targetSocPercent ?? scenario.startSocPercent,
        definition.targetSocRange,
      );
      const floorPercent = clampScenarioPercent(
        Math.max(parameters.floorSocPercent ?? scenario.minAllowedSocPercent, minimumPercent),
        definition.floorSocRange,
      );
      return applyAutoScenario(scenario, floorPercent, "hold", {
        minSocPercent: minimumPercent,
        floorSocPercent: floorPercent,
      });
    },
    buildCommandFromSnapshot(snapshot) {
      const observedSoc = normalisePercent(snapshot.current_soc_percent);
      const holdMinimum = clampToSocRange(extractHoldMinimum(snapshot), definition.targetSocRange);
      const floor = clampToSocRange(
        normalisePercent(snapshot.next_step_soc_percent) ?? holdMinimum ?? observedSoc,
        definition.floorSocRange,
      );
      const minSoc = clampToSocRange(holdMinimum ?? observedSoc ?? floor, definition.targetSocRange);
      if (minSoc == null) {
        return null;
      }
      return {
        hold: {
          minSocPercent: minSoc,
          observedSocPercent: observedSoc,
        },
      };
    },
  };
}

export function createLimitModeDefinition(definition: {
  maxSocRange: BatteryControlSocRange;
  maxChargePowerRange: BatteryControlModeDefinition["maxChargePowerRange"];
}): BatteryControlModeDefinition {
  return {
    id: "limit",
    allowsAutomaticSolarCharging: false,
    maxSocRange: definition.maxSocRange,
    maxChargePowerRange: definition.maxChargePowerRange,
    tieBreakPriority: 1,
    enumerateParameters(scenario) {
      return [{
        maxSocPercent: clampScenarioPercent(scenario.startSocPercent, definition.maxSocRange),
        maxChargePowerW: definition.maxChargePowerRange?.supportsZeroPower ? 0 : definition.maxChargePowerRange?.minPowerW ?? 0,
      }];
    },
    applySlotScenario(scenario, parameters) {
      const capPercent = clampScenarioPercent(
        parameters.maxSocPercent ?? scenario.startSocPercent,
        definition.maxSocRange,
      );
      return applyLimitScenario(scenario, capPercent, {
        maxSocPercent: capPercent,
        maxChargePowerW: parameters.maxChargePowerW ?? 0,
      });
    },
    buildCommandFromSnapshot(snapshot) {
      return {
        limit: {
          maxSocPercent: clampToSocRange(extractLimitMaximum(snapshot), definition.maxSocRange)
            ?? normalisePercent(snapshot.current_soc_percent),
          maxChargePowerW: extractLimitPower(snapshot) ?? resolveZeroCompatibleLimitPower(definition.maxChargePowerRange ?? null),
          ...buildWindowFields(extractModeUntil(snapshot, "limit"), definition.maxChargePowerRange?.supportsWindows ?? false),
        },
      };
    },
    shouldRejectOutcome(context) {
      return shouldRejectHeadroomPreservingMode(context);
    },
  };
}

export function createChargeModeDefinition(definition: {
  targetSocRange: BatteryControlSocRange;
  minChargePowerRange: BatteryControlModeDefinition["minChargePowerRange"];
}): BatteryControlModeDefinition {
  return {
    id: "charge",
    allowsAutomaticSolarCharging: false,
    targetSocRange: definition.targetSocRange,
    minChargePowerRange: definition.minChargePowerRange,
    tieBreakPriority: 3,
    enumerateParameters(scenario) {
      const targetPercent = clampScenarioPercent(scenario.maxAllowedSocPercent, definition.targetSocRange);
      return [{
        targetSocPercent: targetPercent,
        minChargePowerW: resolveFixedChargePower(definition.minChargePowerRange),
      }];
    },
    applySlotScenario(scenario, parameters) {
      const targetPercent = clampScenarioPercent(
        parameters.targetSocPercent ?? scenario.maxAllowedSocPercent,
        definition.targetSocRange,
      );
      const targetStep = clampStepFromPercent(targetPercent, scenario);
      return applyChargeScenario(scenario, targetStep, {
        targetSocPercent: targetPercent,
        minChargePowerW: parameters.minChargePowerW ?? resolveFixedChargePower(definition.minChargePowerRange),
      });
    },
    buildCommandFromSnapshot(snapshot) {
      const chargeTarget = clampToSocRange(extractChargeTarget(snapshot), definition.targetSocRange);
      const minChargePowerW = extractChargePower(snapshot) ?? resolvePreferredBoostPower(definition.minChargePowerRange ?? null);
      const untilTimestamp = extractModeUntil(snapshot, "charge");
      if (untilTimestamp || chargeTarget != null || minChargePowerW != null) {
        return {
          charge: {
            targetSocPercent: chargeTarget,
            minChargePowerW,
            ...buildWindowFields(untilTimestamp, definition.minChargePowerRange?.supportsWindows ?? false),
          },
        };
      }
      return "charge";
    },
  };
}

export function resolvePlannedBatteryControlMode(snapshot: BatteryControlSnapshotLike): BatteryControlMode {
  if (snapshot.current_mode) {
    return snapshot.current_mode;
  }

  const entries = Array.isArray(snapshot.oracle_entries) ? snapshot.oracle_entries : [];
  if (entries.length > 0 && entries[0]?.strategy) {
    return entries[0].strategy;
  }

  const currentSoc = normalisePercent(snapshot.current_soc_percent);
  const nextSoc = normalisePercent(snapshot.next_step_soc_percent);
  if (currentSoc != null && nextSoc != null) {
    if (nextSoc > currentSoc + 0.5) {
      return "charge";
    }
    if (Math.abs(nextSoc - currentSoc) <= 0.5) {
      return "hold";
    }
  }

  return "auto";
}

export function compareModePreference(
  modeDefinitions: BatteryControlModeDefinition[],
  candidate: BatteryControlMode,
  incumbent: BatteryControlMode | null,
): boolean {
  if (!incumbent) {
    return true;
  }
  return resolveModePriority(modeDefinitions, candidate) > resolveModePriority(modeDefinitions, incumbent);
}

export function resolveOracleStrategyForTransition(
  modeDefinitions: BatteryControlModeDefinition[],
  transition: Pick<BatteryControlSlotOutcome, "mode" | "deltaSoCSteps">,
): BatteryControlMode {
  const definition = modeDefinitions.find((mode) => mode.id === transition.mode);
  return definition?.resolveOracleStrategy?.(transition, new Set(modeDefinitions.map((mode) => mode.id))) ?? transition.mode;
}

function clampToSocRange(value: number | null, range: BatteryControlSocRange | null): number | null {
  if (value == null || !Number.isFinite(value) || !range) {
    return null;
  }
  const bounded = Math.min(range.maxPercent, Math.max(range.minPercent, value));
  if (range.stepPercent == null || range.stepPercent <= 0) {
    return bounded;
  }
  return Math.round(bounded / range.stepPercent) * range.stepPercent;
}

function clampToPowerRange(
  value: number | null,
  range: (BatteryControlPowerRange & {supportsWindows?: boolean; fixedPowerW?: number | null}) | null,
): number | null {
  if (value == null || !Number.isFinite(value) || !range) {
    return null;
  }
  const upperBound = range.maxPowerW == null ? value : Math.min(value, range.maxPowerW);
  const lowerBound = Math.max(range.minPowerW, upperBound);
  if (range.stepPowerW == null || range.stepPowerW <= 0) {
    return lowerBound;
  }
  return Math.round(lowerBound / range.stepPowerW) * range.stepPowerW;
}

function applyAutoScenario(
  scenario: BatteryControlSlotScenario,
  floorPercent: number,
  mode: BatteryControlMode = "auto",
  parameters: BatteryControlModeParameters = {floorSocPercent: floorPercent},
): BatteryControlSlotOutcome {
  const floorStep = clampStepFromPercent(floorPercent, scenario);
  const headroomSteps = Math.max(0, scenario.maxAllowedSoCStep - scenario.startSocStep);
  const dischargeSteps = Math.max(0, scenario.startSocStep - Math.max(scenario.minAllowedSoCStep, floorStep));
  const solarSurplusWh = Math.max(0, scenario.availableSolarWh - scenario.loadAfterDirectUseWh);
  const siteDeficitWh = Math.max(0, scenario.loadAfterDirectUseWh - scenario.availableSolarWh);

  if (solarSurplusWh > 0 && headroomSteps > 0) {
    const outcome = findBestChargeOutcome(mode, scenario, parameters, scenario.startSocStep + headroomSteps, scenario.solarChargeLimitWh, true);
    if (outcome) {
      return outcome;
    }
  }

  if (siteDeficitWh > 0 && dischargeSteps > 0) {
    const dischargeLimitWh = scenario.dischargeLimitWh == null ? siteDeficitWh : Math.min(siteDeficitWh, scenario.dischargeLimitWh);
    const chargeSteps = -clampStoredEnergyToSteps(dischargeLimitWh, scenario);
    return buildChargeDischargeOutcome(mode, scenario, chargeSteps, parameters);
  }

  return buildStaticOutcome(mode, scenario, scenario.startSocStep, parameters);
}

function applyLimitScenario(
  scenario: BatteryControlSlotScenario,
  maxPercent: number,
  parameters: BatteryControlModeParameters,
): BatteryControlSlotOutcome {
  const maxStep = clampStepFromPercent(maxPercent, scenario);
  const effectiveMaxStep = Math.max(scenario.startSocStep, maxStep);
  return applyAutoScenario(
    {
      ...scenario,
      maxAllowedSocPercent: Math.max(scenario.startSocPercent, maxPercent),
      maxAllowedSoCStep: effectiveMaxStep,
    },
    scenario.minAllowedSocPercent,
    "limit",
    parameters,
  );
}

function applyChargeScenario(
  scenario: BatteryControlSlotScenario,
  targetStep: number,
  parameters: BatteryControlModeParameters,
): BatteryControlSlotOutcome {
  const boundedTargetStep = Math.max(scenario.startSocStep, Math.min(targetStep, scenario.maxAllowedSoCStep));
  const headroomSteps = Math.max(0, boundedTargetStep - scenario.startSocStep);
  if (headroomSteps === 0) {
    return buildStaticOutcome("charge", scenario, scenario.startSocStep, parameters);
  }

  const maxBatteryBusWh = scenario.gridChargeLimitWh;
  return findBestChargeOutcome("charge", scenario, parameters, boundedTargetStep, maxBatteryBusWh, false)
    ?? buildStaticOutcome("charge", scenario, scenario.startSocStep, parameters);
}

function buildStaticOutcome(
  mode: BatteryControlMode,
  scenario: BatteryControlSlotScenario,
  nextSoCStep: number,
  parameters: BatteryControlModeParameters,
): BatteryControlSlotOutcome {
  return buildChargeDischargeOutcome(mode, scenario, nextSoCStep - scenario.startSocStep, parameters);
}

function buildChargeDischargeOutcome(
  mode: BatteryControlMode,
  scenario: BatteryControlSlotScenario,
  deltaSoCSteps: number,
  parameters: BatteryControlModeParameters,
): BatteryControlSlotOutcome {
  const nextSoCStep = Math.max(
    scenario.minAllowedSoCStep,
    Math.min(scenario.startSocStep + deltaSoCSteps, scenario.maxAllowedSoCStep),
  );
  const actualDeltaSteps = nextSoCStep - scenario.startSocStep;
  const storedEnergyWh = actualDeltaSteps * scenario.energyPerStepWh;
  const transitionEfficiencies = resolveTransitionEfficiencies(
    scenario.chemistry,
    Energy.fromWattHours(storedEnergyWh),
    Duration.fromHours(scenario.durationHours),
    Energy.fromWattHours(scenario.capacityWh),
    Percentage.fromRatio(scenario.chargeEfficiencyRatio),
    Percentage.fromRatio(scenario.dischargeEfficiencyRatio),
    scenario.chargeAverageCRate,
    scenario.dischargeAverageCRate,
  );
  const batteryEnergyAtBusWh = energyAtBusFromStoredEnergyChange(
    storedEnergyWh,
    transitionEfficiencies.chargeEfficiency.ratio,
    transitionEfficiencies.dischargeEfficiency.ratio,
  );
  const gridEnergyWh = scenario.loadAfterDirectUseWh + batteryEnergyAtBusWh - scenario.availableSolarWh;
  const gridImportWh = Math.max(0, gridEnergyWh);
  const additionalGridChargeWh = storedEnergyWh > 0
    ? Math.max(0, gridImportWh - scenario.baselineGridImportWh)
    : 0;

  return {
    mode,
    parameters,
    nextSoCStep,
    endSocPercent: nextSoCStep * scenario.socPercentStep,
    deltaSoCSteps: actualDeltaSteps,
    storedEnergyWh,
    batteryEnergyAtBusWh,
    gridEnergyWh,
    additionalGridChargeWh,
  };
}

function clampScenarioPercent(value: number, range: BatteryControlSocRange): number {
  const bounded = Math.min(range.maxPercent, Math.max(range.minPercent, value));
  if (range.stepPercent == null || range.stepPercent <= 0) {
    return bounded;
  }
  return Math.round(bounded / range.stepPercent) * range.stepPercent;
}

function clampStepFromPercent(value: number, scenario: BatteryControlSlotScenario): number {
  return Math.max(
    scenario.minAllowedSoCStep,
    Math.min(Math.round(value / scenario.socPercentStep), scenario.maxAllowedSoCStep),
  );
}

function clampStoredEnergyToSteps(storedEnergyWh: number, scenario: BatteryControlSlotScenario): number {
  if (storedEnergyWh <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(storedEnergyWh / scenario.energyPerStepWh + 1e-9));
}

function findBestChargeOutcome(
  mode: BatteryControlMode,
  scenario: BatteryControlSlotScenario,
  parameters: BatteryControlModeParameters,
  targetStep: number,
  maxBatteryBusWh: number,
  requireNoGridCharge: boolean,
): BatteryControlSlotOutcome | null {
  for (let nextStep = targetStep; nextStep >= scenario.startSocStep; nextStep -= 1) {
    const outcome = buildChargeDischargeOutcome(mode, scenario, nextStep - scenario.startSocStep, parameters);
    if (outcome.batteryEnergyAtBusWh > maxBatteryBusWh + 1e-9) {
      continue;
    }
    if (requireNoGridCharge && outcome.additionalGridChargeWh > 1e-9) {
      continue;
    }
    return outcome;
  }
  return null;
}

function resolveFixedChargePower(
  range: BatteryControlModeDefinition["minChargePowerRange"],
): number | null {
  if (!range) {
    return null;
  }
  if (typeof range.fixedPowerW === "number" && Number.isFinite(range.fixedPowerW)) {
    return range.fixedPowerW;
  }
  if (typeof range.maxPowerW === "number" && Number.isFinite(range.maxPowerW)) {
    return range.maxPowerW;
  }
  return range.minPowerW > 0 ? range.minPowerW : null;
}

function resolveModePriority(modeDefinitions: BatteryControlModeDefinition[], mode: BatteryControlMode): number {
  return modeDefinitions.find((definition) => definition.id === mode)?.tieBreakPriority ?? 0;
}

function normalisePercent(value: unknown): number | null {
  if (value instanceof Percentage) {
    return value.percent;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value <= 0) {
    return 0;
  }
  if (value >= 100) {
    return 100;
  }
  return value;
}

function normalisePower(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, value);
}

function extractModeUntil(
  snapshot: BatteryControlSnapshotLike,
  strategy: "charge" | "limit",
): string | null {
  const entries = Array.isArray(snapshot.oracle_entries) ? snapshot.oracle_entries : [];
  const eras = Array.isArray(snapshot.forecast_eras) ? snapshot.forecast_eras : [];
  if (!entries.length || !eras.length) {
    return null;
  }
  const eraEndById = new Map(
    eras
      .filter((era) => typeof era.era_id === "string" && era.era_id.length > 0 && typeof era.end === "string" && era.end.length > 0)
      .map((era) => [era.era_id, era.end as string]),
  );
  let untilTimestamp: string | null = null;
  for (const entry of entries) {
    if (entry.strategy !== strategy) {
      break;
    }
    const eraEnd = eraEndById.get(entry.era_id ?? "");
    if (eraEnd) {
      untilTimestamp = eraEnd;
    }
  }
  return untilTimestamp;
}

function extractChargeTarget(snapshot: BatteryControlSnapshotLike): number | null {
  const entries = Array.isArray(snapshot.oracle_entries) ? snapshot.oracle_entries : [];
  let target: number | null = null;
  for (const entry of entries) {
    if (entry.strategy !== "charge") {
      break;
    }
    const candidate = entry.mode_params?.target_soc_percent ?? entry.target_soc_percent ?? entry.end_soc_percent ?? entry.start_soc_percent ?? null;
    const normalised = normalisePercent(candidate);
    if (normalised != null) {
      target = normalised;
    }
  }
  return target ?? normalisePercent(snapshot.next_step_soc_percent) ?? normalisePercent(snapshot.current_soc_percent);
}

function extractHoldMinimum(snapshot: BatteryControlSnapshotLike): number | null {
  const entries = Array.isArray(snapshot.oracle_entries) ? snapshot.oracle_entries : [];
  const holdEntry = entries.find((entry) => entry.strategy === "hold");
  if (holdEntry) {
    const candidate = holdEntry.target_soc_percent ?? holdEntry.end_soc_percent ?? holdEntry.start_soc_percent ?? null;
    const explicitCandidate = holdEntry.mode_params?.min_soc_percent ?? candidate;
    const normalised = normalisePercent(explicitCandidate);
    if (normalised != null) {
      return normalised;
    }
  }
  return normalisePercent(snapshot.next_step_soc_percent) ?? normalisePercent(snapshot.current_soc_percent);
}

function extractChargePower(snapshot: BatteryControlSnapshotLike): number | null {
  const firstEntry = Array.isArray(snapshot.oracle_entries) ? snapshot.oracle_entries.find((entry) => entry.strategy === "charge") : null;
  return normalisePower(firstEntry?.mode_params?.min_charge_power_w ?? null);
}

function extractLimitPower(snapshot: BatteryControlSnapshotLike): number | null {
  const firstEntry = Array.isArray(snapshot.oracle_entries) ? snapshot.oracle_entries.find((entry) => entry.strategy === "limit") : null;
  return normalisePower(firstEntry?.mode_params?.max_charge_power_w ?? null);
}

function extractAutoFloor(snapshot: BatteryControlSnapshotLike): number | null {
  const firstEntry = Array.isArray(snapshot.oracle_entries) ? snapshot.oracle_entries[0] : null;
  return normalisePercent(firstEntry?.mode_params?.floor_soc_percent ?? snapshot.next_step_soc_percent);
}

function extractLimitMaximum(snapshot: BatteryControlSnapshotLike): number | null {
  const firstEntry = Array.isArray(snapshot.oracle_entries) ? snapshot.oracle_entries[0] : null;
  return normalisePercent(firstEntry?.mode_params?.max_soc_percent ?? firstEntry?.end_soc_percent ?? snapshot.next_step_soc_percent)
    ?? normalisePercent(snapshot.current_soc_percent);
}

function resolvePreferredBoostPower(
  range: BatteryControlModeDefinition["minChargePowerRange"] | null,
): number | null {
  if (!range) {
    return null;
  }
  if (typeof range.fixedPowerW === "number" && Number.isFinite(range.fixedPowerW)) {
    return range.fixedPowerW;
  }
  if (typeof range.maxPowerW === "number" && Number.isFinite(range.maxPowerW)) {
    return range.maxPowerW;
  }
  return range.minPowerW > 0 ? range.minPowerW : null;
}

function resolveZeroCompatibleLimitPower(
  range: BatteryControlModeDefinition["maxChargePowerRange"] | null,
): number | null {
  if (!range || range.supportsZeroPower) {
    return 0;
  }
  return range.minPowerW;
}

function buildWindowFields(untilTimestamp: string | null, supportsWindows: boolean): BatteryControlWindow {
  if (!supportsWindows || !untilTimestamp) {
    return {};
  }
  return {untilTimestamp};
}

function shouldRejectHeadroomPreservingMode(context: BatteryControlModeRejectionContext): boolean {
  const solarSurplusWh = context.scenario.availableSolarWh - context.scenario.loadAfterDirectUseWh;
  if (solarSurplusWh <= EPSILON) {
    return false;
  }
  if (context.scenario.startSocStep >= Math.round(context.scenario.maxAllowedSoCStep * LIMIT_HEADROOM_MIN_SOC_FRACTION)) {
    return false;
  }
  if (context.minFutureImportPriceEurPerKwh == null || !Number.isFinite(context.minFutureImportPriceEurPerKwh)) {
    return true;
  }
  return context.currentPriceEurPerKwh - context.minFutureImportPriceEurPerKwh < LIMIT_HEADROOM_FUTURE_PRICE_ADVANTAGE_EUR_PER_KWH;
}

function energyAtBusFromStoredEnergyChange(
  storedEnergyWh: number,
  chargeEfficiencyRatio: number,
  dischargeEfficiencyRatio: number,
): number {
  if (storedEnergyWh > 0) {
    return storedEnergyWh / chargeEfficiencyRatio;
  }
  if (storedEnergyWh < 0) {
    return storedEnergyWh * dischargeEfficiencyRatio;
  }
  return 0;
}
