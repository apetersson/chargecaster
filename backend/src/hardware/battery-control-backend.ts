import type { BatteryControlMode, SimulationConfig } from "@chargecaster/domain";

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
