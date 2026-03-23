import { Duration, Energy, Percentage } from "@chargecaster/domain";
import type { BatteryChemistry } from "@chargecaster/domain";

export interface TransitionEfficiencies {
  chargeEfficiency: Percentage;
  dischargeEfficiency: Percentage;
}

export interface BatteryEfficiencyCurveInput {
  storedEnergyChange: Energy;
  duration: Duration;
  capacity: Energy;
  baseChargeEfficiency: Percentage;
  baseDischargeEfficiency: Percentage;
  chargeReferenceCRate: number | null | undefined;
  dischargeReferenceCRate: number | null | undefined;
}

export interface BatteryEfficiencyCurve {
  readonly chemistry: BatteryChemistry;
  resolveTransitionEfficiencies(input: BatteryEfficiencyCurveInput): TransitionEfficiencies;
}

interface ResistancePoint {
  cRate: number;
  resistanceMilliOhms: number;
}

// LiFePO4 room-temperature cell data from:
// Patrik Ollas et al., "Battery loss prediction using various loss models:
// A case study for a residential building", Journal of Energy Storage 70
// (2023) 108048, doi:10.1016/j.est.2023.108048.
//
// Table 1 provides the 12 Ah LiFePO4 cell specification. Table 2 provides the
// measured current-dependent internal resistance points. We use those
// resistance points directly, linearly interpolate between them, and derive
// charge/discharge efficiency from a simple R_int loss model. The paper curve
// is applied as a relative adjustment around the measured average operating
// C-rate from recent history, so the learned pack-specific efficiency remains
// the main calibration anchor and the paper only "homogenises" the rate effect.
const LFP_CELL_CAPACITY_AMP_HOURS = 12;
const LFP_DEFAULT_REFERENCE_C_RATE = 0.25;

// Equation (12) in Ollas et al. gives a linear OCV approximation in the
// 15%-90% SOC operating band: u_ocv(SOC) = 0.00133 * SOC + 3.234.
// We use the mid-band value at 50% SOC as a single representative cell OCV.
const LFP_REFERENCE_OCV_VOLTS = 0.00133 * 50 + 3.234;

const LFP_INTERNAL_RESISTANCE_BY_C_RATE: ResistancePoint[] = [
  {cRate: 0.01, resistanceMilliOhms: 185.4},
  {cRate: 0.03, resistanceMilliOhms: 78.3},
  {cRate: 0.1, resistanceMilliOhms: 36.1},
  {cRate: 0.17, resistanceMilliOhms: 29.0},
  {cRate: 0.25, resistanceMilliOhms: 23.6},
  {cRate: 0.5, resistanceMilliOhms: 19.1},
  {cRate: 1.0, resistanceMilliOhms: 14.0},
  {cRate: 1.5, resistanceMilliOhms: 11.0},
] as const;

export class Lifepo4BatteryEfficiencyCurve implements BatteryEfficiencyCurve {
  readonly chemistry = "lifepo4" as const;

  resolveTransitionEfficiencies(input: BatteryEfficiencyCurveInput): TransitionEfficiencies {
    const {
      storedEnergyChange,
      duration,
      capacity,
      baseChargeEfficiency,
      baseDischargeEfficiency,
      chargeReferenceCRate,
      dischargeReferenceCRate,
    } = input;

    if (
      storedEnergyChange.wattHours === 0 ||
      !(duration.hours > 0) ||
      !(capacity.kilowattHours > 0)
    ) {
      return {
        chargeEfficiency: baseChargeEfficiency,
        dischargeEfficiency: baseDischargeEfficiency,
      };
    }

    const cRate = Math.abs(storedEnergyChange.kilowattHours) / capacity.kilowattHours / duration.hours;
    if (!(cRate > 0)) {
      return {
        chargeEfficiency: baseChargeEfficiency,
        dischargeEfficiency: baseDischargeEfficiency,
      };
    }

    const modeled = this.resolveModeledEfficiencies(cRate);

    if (storedEnergyChange.wattHours > 0) {
      const referenceEfficiencies = this.resolveModeledEfficiencies(
        normalizeReferenceCRate(chargeReferenceCRate),
      );
      return {
        chargeEfficiency: scaleEfficiencyFromReference(
          baseChargeEfficiency,
          modeled.chargeEfficiency,
          referenceEfficiencies.chargeEfficiency,
        ),
        dischargeEfficiency: baseDischargeEfficiency,
      };
    }

    const referenceEfficiencies = this.resolveModeledEfficiencies(
      normalizeReferenceCRate(dischargeReferenceCRate),
    );
    return {
      chargeEfficiency: baseChargeEfficiency,
      dischargeEfficiency: scaleEfficiencyFromReference(
        baseDischargeEfficiency,
        modeled.dischargeEfficiency,
        referenceEfficiencies.dischargeEfficiency,
      ),
    };
  }

  private resolveModeledEfficiencies(cRate: number): TransitionEfficiencies {
    const resistanceOhms = interpolateResistanceMilliOhms(cRate) / 1000;
    const currentAmps = cRate * LFP_CELL_CAPACITY_AMP_HOURS;
    const voltageDrop = currentAmps * resistanceOhms;

    return {
      chargeEfficiency: Percentage.fromRatio(
        clampRatio(LFP_REFERENCE_OCV_VOLTS / (LFP_REFERENCE_OCV_VOLTS + voltageDrop)),
      ),
      dischargeEfficiency: Percentage.fromRatio(
        clampRatio((LFP_REFERENCE_OCV_VOLTS - voltageDrop) / LFP_REFERENCE_OCV_VOLTS),
      ),
    };
  }
}

const BATTERY_EFFICIENCY_CURVES: Partial<Record<NonNullable<BatteryChemistry>, BatteryEfficiencyCurve>> = {
  lifepo4: new Lifepo4BatteryEfficiencyCurve(),
};

export function resolveTransitionEfficiencies(
  chemistry: BatteryChemistry | null | undefined,
  storedEnergyChange: Energy,
  duration: Duration,
  capacity: Energy,
  baseChargeEfficiency: Percentage,
  baseDischargeEfficiency: Percentage,
  chargeReferenceCRate: number | null | undefined,
  dischargeReferenceCRate: number | null | undefined,
): TransitionEfficiencies {
  const curve = chemistry ? BATTERY_EFFICIENCY_CURVES[chemistry] : undefined;
  if (!curve) {
    return {
      chargeEfficiency: baseChargeEfficiency,
      dischargeEfficiency: baseDischargeEfficiency,
    };
  }

  return curve.resolveTransitionEfficiencies({
    storedEnergyChange,
    duration,
    capacity,
    baseChargeEfficiency,
    baseDischargeEfficiency,
    chargeReferenceCRate,
    dischargeReferenceCRate,
  });
}

function interpolateResistanceMilliOhms(cRate: number): number {
  const first = LFP_INTERNAL_RESISTANCE_BY_C_RATE[0];
  const last = LFP_INTERNAL_RESISTANCE_BY_C_RATE[LFP_INTERNAL_RESISTANCE_BY_C_RATE.length - 1];

  if (cRate <= first.cRate) {
    return first.resistanceMilliOhms;
  }

  if (cRate >= last.cRate) {
    return last.resistanceMilliOhms;
  }

  for (let index = 1; index < LFP_INTERNAL_RESISTANCE_BY_C_RATE.length; index += 1) {
    const upper = LFP_INTERNAL_RESISTANCE_BY_C_RATE[index];
    const lower = LFP_INTERNAL_RESISTANCE_BY_C_RATE[index - 1];
    if (cRate > upper.cRate) {
      continue;
    }

    const span = upper.cRate - lower.cRate;
    if (!(span > 0)) {
      return upper.resistanceMilliOhms;
    }

    const share = (cRate - lower.cRate) / span;
    return lower.resistanceMilliOhms + (upper.resistanceMilliOhms - lower.resistanceMilliOhms) * share;
  }

  return last.resistanceMilliOhms;
}

function scaleEfficiencyFromReference(
  baseEfficiency: Percentage,
  modeledEfficiency: Percentage,
  referenceEfficiency: Percentage,
): Percentage {
  if (!(referenceEfficiency.ratio > 0)) {
    return baseEfficiency;
  }

  return Percentage.fromRatio(clampRatio(baseEfficiency.ratio * modeledEfficiency.ratio / referenceEfficiency.ratio));
}

function normalizeReferenceCRate(referenceCRate: number | null | undefined): number {
  if (typeof referenceCRate !== "number" || !Number.isFinite(referenceCRate) || !(referenceCRate > 0)) {
    return LFP_DEFAULT_REFERENCE_C_RATE;
  }
  return referenceCRate;
}

function clampRatio(value: number): number {
  if (Number.isNaN(value)) {
    return 0;
  }

  return Math.max(0, Math.min(1, value));
}
