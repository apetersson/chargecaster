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
  | {limit: BatteryControlWindow & {floorSocPercent?: number | null; maxChargePowerW?: number | null}}
  | {hold: {minSocPercent: number; observedSocPercent?: number | null; floorSocPercent?: number | null}};

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
  floorSocRange?: BatteryControlSocRange | null;
  targetSocRange?: BatteryControlSocRange | null;
  minChargePowerRange?: (BatteryControlPowerRange & {supportsWindows: boolean; fixedPowerW?: number | null}) | null;
  maxChargePowerRange?: (BatteryControlPowerRange & {supportsWindows: boolean}) | null;
  enumerateParameters(scenario: BatteryControlSlotScenario): BatteryControlModeParameters[];
  applySlotScenario(scenario: BatteryControlSlotScenario, parameters: BatteryControlModeParameters): BatteryControlSlotOutcome | null;
  reverseApplySlotScenario?(scenario: BatteryControlSlotScenario, parameters: BatteryControlModeParameters): BatteryControlSlotOutcome[] | null;
}

export interface BatteryControlModeParameters {
  floorSocPercent?: number | null;
  targetSocPercent?: number | null;
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
    canPreventAutomaticSolarCharging: availableModes.includes("hold") || availableModes.includes("limit"),
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
        floorSocRange: {minPercent: 0, maxPercent: 100, stepPercent: 1},
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
    floorSocRange: definition.floorSocRange,
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
  };
}

export function createHoldModeDefinition(definition: {
  floorSocRange: BatteryControlSocRange;
  targetSocRange: BatteryControlSocRange;
}): BatteryControlModeDefinition {
  return {
    id: "hold",
    floorSocRange: definition.floorSocRange,
    targetSocRange: definition.targetSocRange,
    enumerateParameters(scenario) {
      const targetPercent = clampScenarioPercent(scenario.startSocPercent, definition.targetSocRange);
      const floorPercent = clampScenarioPercent(Math.min(targetPercent, scenario.startSocPercent), definition.floorSocRange);
      return [{targetSocPercent: targetPercent, floorSocPercent: floorPercent}];
    },
    applySlotScenario(scenario, parameters) {
      const targetPercent = clampScenarioPercent(
        parameters.targetSocPercent ?? scenario.startSocPercent,
        definition.targetSocRange,
      );
      const targetStep = clampStepFromPercent(targetPercent, scenario);
      return buildStaticOutcome("hold", scenario, targetStep, {
        targetSocPercent: targetPercent,
        floorSocPercent: clampScenarioPercent(parameters.floorSocPercent ?? scenario.minAllowedSocPercent, definition.floorSocRange),
      });
    },
  };
}

export function createLimitModeDefinition(definition: {
  floorSocRange: BatteryControlSocRange;
  maxChargePowerRange: BatteryControlModeDefinition["maxChargePowerRange"];
}): BatteryControlModeDefinition {
  return {
    id: "limit",
    floorSocRange: definition.floorSocRange,
    maxChargePowerRange: definition.maxChargePowerRange,
    enumerateParameters(scenario) {
      return [{
        floorSocPercent: clampScenarioPercent(scenario.minAllowedSocPercent, definition.floorSocRange),
        maxChargePowerW: definition.maxChargePowerRange?.supportsZeroPower ? 0 : definition.maxChargePowerRange?.minPowerW ?? 0,
      }];
    },
    applySlotScenario(scenario, parameters) {
      const targetStep = clampStepFromPercent(scenario.startSocPercent, scenario);
      return buildStaticOutcome("limit", scenario, targetStep, {
        floorSocPercent: clampScenarioPercent(parameters.floorSocPercent ?? scenario.minAllowedSocPercent, definition.floorSocRange),
        maxChargePowerW: parameters.maxChargePowerW ?? 0,
      });
    },
  };
}

export function createChargeModeDefinition(definition: {
  targetSocRange: BatteryControlSocRange;
  minChargePowerRange: BatteryControlModeDefinition["minChargePowerRange"];
}): BatteryControlModeDefinition {
  return {
    id: "charge",
    targetSocRange: definition.targetSocRange,
    minChargePowerRange: definition.minChargePowerRange,
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
  };
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
): BatteryControlSlotOutcome {
  const floorStep = clampStepFromPercent(floorPercent, scenario);
  const headroomSteps = Math.max(0, scenario.maxAllowedSoCStep - scenario.startSocStep);
  const dischargeSteps = Math.max(0, scenario.startSocStep - Math.max(scenario.minAllowedSoCStep, floorStep));
  const solarSurplusWh = Math.max(0, scenario.availableSolarWh - scenario.loadAfterDirectUseWh);
  const siteDeficitWh = Math.max(0, scenario.loadAfterDirectUseWh - scenario.availableSolarWh);

  if (solarSurplusWh > 0 && headroomSteps > 0) {
    const outcome = findBestChargeOutcome("auto", scenario, {
      floorSocPercent: floorPercent,
    }, scenario.startSocStep + headroomSteps, scenario.solarChargeLimitWh, true);
    if (outcome) {
      return outcome;
    }
  }

  if (siteDeficitWh > 0 && dischargeSteps > 0) {
    const dischargeLimitWh = scenario.dischargeLimitWh == null ? siteDeficitWh : Math.min(siteDeficitWh, scenario.dischargeLimitWh);
    const chargeSteps = -clampStoredEnergyToSteps(dischargeLimitWh, scenario);
    return buildChargeDischargeOutcome("auto", scenario, chargeSteps, {
      floorSocPercent: floorPercent,
    });
  }

  return buildStaticOutcome("auto", scenario, scenario.startSocStep, {
    floorSocPercent: floorPercent,
  });
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
