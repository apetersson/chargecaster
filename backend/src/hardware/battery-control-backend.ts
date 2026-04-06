import type { SimulationConfig } from "@chargecaster/domain";

export const BATTERY_CONTROL_BACKEND = Symbol("BATTERY_CONTROL_BACKEND");

export type BatteryControlMode = "charge" | "auto" | "hold" | "limit";

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

export interface BatteryControlCapabilities {
  backendId: string;
  modeSupport: {
    auto: boolean;
    holdTargetSoc: boolean;
    chargeToTargetSoc: boolean;
    chargeLimitPower: boolean;
    chargeBoostPower: boolean;
    absoluteChargeWindow: boolean;
    recurringScheduleWindow: boolean;
  };
  autoFloorSocRange: BatteryControlSocRange;
  targetSocRange: BatteryControlSocRange;
  chargeLimitPowerRange: (BatteryControlPowerRange & {supportsWindows: boolean}) | null;
  chargeBoostPowerRange: (BatteryControlPowerRange & {supportsWindows: boolean; fixedPowerW: number | null}) | null;
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
  allowGridChargeFromGrid: boolean;
  canHoldTargetSoc: boolean;
  canLimitChargePower: boolean;
  canPreventAutomaticSolarCharging: boolean;
}

export function deriveBatteryOptimisationConstraints(
  capabilities?: BatteryControlCapabilities | null,
): BatteryOptimisationConstraints {
  if (!capabilities) {
    return {
      allowGridChargeFromGrid: true,
      canHoldTargetSoc: true,
      canLimitChargePower: true,
      canPreventAutomaticSolarCharging: true,
    };
  }

  const canHoldTargetSoc = capabilities.modeSupport.holdTargetSoc;
  const canLimitChargePower = capabilities.modeSupport.chargeLimitPower;

  return {
    allowGridChargeFromGrid: capabilities.modeSupport.chargeToTargetSoc,
    canHoldTargetSoc,
    canLimitChargePower,
    canPreventAutomaticSolarCharging: canHoldTargetSoc || canLimitChargePower,
  };
}

export function clampSimulationConfigToBatteryCapabilities(
  config: SimulationConfig,
  capabilities?: BatteryControlCapabilities | null,
): SimulationConfig {
  if (!capabilities) {
    return config;
  }

  const floorSoc = clampToSocRange(config.battery.auto_mode_floor_soc ?? null, capabilities.autoFloorSocRange);
  const maxChargeSocCandidate = clampToSocRange(config.battery.max_charge_soc_percent ?? null, capabilities.targetSocRange);
  const maxChargeSoc = maxChargeSocCandidate == null
    ? floorSoc
    : floorSoc == null
      ? maxChargeSocCandidate
      : Math.max(floorSoc, maxChargeSocCandidate);

  const maxChargePowerCandidate = clampToPowerRange(
    config.battery.max_charge_power_w ?? null,
    capabilities.chargeBoostPowerRange,
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

function clampToSocRange(value: number | null, range: BatteryControlSocRange): number | null {
  if (value == null || !Number.isFinite(value)) {
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
