import { Inject, Injectable, Logger } from "@nestjs/common";

import { Duration, Energy, Percentage, Power } from "@chargecaster/domain";
import type { HistoryPoint } from "@chargecaster/domain";
import { StorageService } from "../storage/storage.service";

const LOOKBACK_DAYS = 7;
const MAX_INTERVAL_HOURS = 1 / 6;
const MIN_INTERVAL_STEPS_PER_RUN = 3;
const MIN_SOC_DELTA_FRACTION_PER_RUN = 0.02;
const MIN_EXTERNAL_ENERGY_KWH_PER_RUN = 0.2;
const POWER_THRESHOLD_W = 300;
const HALF_LIFE_DAYS = 2;
const DEFAULT_CHARGE_EFFICIENCY = Percentage.fromRatio(0.95);
const DEFAULT_DISCHARGE_EFFICIENCY = Percentage.fromRatio(0.95);
const MIN_EFFICIENCY = Percentage.fromRatio(0.75);
const MAX_EFFICIENCY = Percentage.fromRatio(0.995);
const MIN_RUNS_PER_SIDE = 5;

interface EfficiencyRun {
  endedAtMs: number;
  externalEnergy: Energy;
  socDelta: Percentage;
}

export interface BatteryEfficiencyEstimate {
  chargeEfficiency: Percentage;
  dischargeEfficiency: Percentage;
  chargeRuns: number;
  dischargeRuns: number;
  source: "estimated" | "fallback";
}

interface EfficiencyPoint {
  timestampMs: number;
  batterySoc: Percentage;
  batteryPower: Power;
}

interface OpenRun {
  kind: "charge" | "discharge";
  startedAtMs: number;
  endedAtMs: number;
  startSoc: Percentage;
  endSoc: Percentage;
  externalEnergy: Energy;
  steps: number;
}

@Injectable()
export class BatteryEfficiencyService {
  private readonly logger = new Logger(BatteryEfficiencyService.name);

  constructor(@Inject(StorageService) private readonly storageRef: StorageService) {}

  estimateRecentEfficiencies(capacity: Energy, now = new Date()): BatteryEfficiencyEstimate {
    if (!(capacity.wattHours > 0)) {
      return this.buildFallbackEstimate();
    }

    const start = new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const end = now.toISOString();
    const records = this.storageRef.listHistoryRangeAsc(start, end);
    const points = records
      .map((record) => this.toEfficiencyPoint(record.payload))
      .filter((point): point is EfficiencyPoint => point !== null);

    const {chargeRuns, dischargeRuns} = this.collectRuns(points);
    if (chargeRuns.length < MIN_RUNS_PER_SIDE || dischargeRuns.length < MIN_RUNS_PER_SIDE) {
      this.logger.verbose(
        `Battery efficiency fallback: charge_runs=${chargeRuns.length}, discharge_runs=${dischargeRuns.length}`,
      );
      return this.buildFallbackEstimate(chargeRuns.length, dischargeRuns.length);
    }

    const chargeEfficiency = this.estimateChargeEfficiency(chargeRuns, capacity, now.getTime());
    const dischargeEfficiency = this.estimateDischargeEfficiency(dischargeRuns, capacity, now.getTime());

    this.logger.verbose(
      `Estimated battery efficiencies from recent history: charge=${chargeEfficiency.percent.toFixed(2)}%, ` +
      `discharge=${dischargeEfficiency.percent.toFixed(2)}%, charge_runs=${chargeRuns.length}, ` +
      `discharge_runs=${dischargeRuns.length}`,
    );

    return {
      chargeEfficiency,
      dischargeEfficiency,
      chargeRuns: chargeRuns.length,
      dischargeRuns: dischargeRuns.length,
      source: "estimated",
    };
  }

  private buildFallbackEstimate(
    chargeRuns = 0,
    dischargeRuns = 0,
  ): BatteryEfficiencyEstimate {
    return {
      chargeEfficiency: DEFAULT_CHARGE_EFFICIENCY,
      dischargeEfficiency: DEFAULT_DISCHARGE_EFFICIENCY,
      chargeRuns,
      dischargeRuns,
      source: "fallback",
    };
  }

  private toEfficiencyPoint(point: HistoryPoint): EfficiencyPoint | null {
    const batterySocPercent = point.battery_soc_percent;
    const gridPowerW = point.grid_power_w;
    const solarPowerW = point.solar_power_w;
    const siteDemandPowerW = point.site_demand_power_w;
    if (
      typeof batterySocPercent !== "number" ||
      !Number.isFinite(batterySocPercent) ||
      typeof gridPowerW !== "number" ||
      !Number.isFinite(gridPowerW) ||
      typeof solarPowerW !== "number" ||
      !Number.isFinite(solarPowerW) ||
      typeof siteDemandPowerW !== "number" ||
      !Number.isFinite(siteDemandPowerW)
    ) {
      return null;
    }
    const timestampMs = Date.parse(point.timestamp);
    if (!Number.isFinite(timestampMs)) {
      return null;
    }
    return {
      timestampMs,
      batterySoc: Percentage.fromPercent(batterySocPercent),
      batteryPower: Power.fromWatts(siteDemandPowerW - solarPowerW - gridPowerW),
    };
  }

  private collectRuns(points: EfficiencyPoint[]): {chargeRuns: EfficiencyRun[]; dischargeRuns: EfficiencyRun[]} {
    const chargeRuns: EfficiencyRun[] = [];
    const dischargeRuns: EfficiencyRun[] = [];
    let currentRun: OpenRun | null = null;

    for (let index = 1; index < points.length; index += 1) {
      const previous = points[index - 1];
      const current = points[index];
      const durationHours = (current.timestampMs - previous.timestampMs) / (60 * 60 * 1000);
      if (!(durationHours > 0) || durationHours > MAX_INTERVAL_HOURS) {
        currentRun = this.flushRun(currentRun, chargeRuns, dischargeRuns);
        continue;
      }

      const averageBatteryPower = previous.batteryPower.add(current.batteryPower).scale(0.5);
      const socDeltaPercent = current.batterySoc.percent - previous.batterySoc.percent;
      const kind = this.classifyInterval(averageBatteryPower, socDeltaPercent);
      if (!kind) {
        currentRun = this.flushRun(currentRun, chargeRuns, dischargeRuns);
        continue;
      }

      const externalEnergy = Energy.fromWattHours(
        Math.abs(averageBatteryPower.forDuration(Duration.fromHours(durationHours)).wattHours),
      );
      if (!currentRun || currentRun.kind !== kind) {
        currentRun = this.flushRun(currentRun, chargeRuns, dischargeRuns);
        currentRun = {
          kind,
          startedAtMs: previous.timestampMs,
          endedAtMs: current.timestampMs,
          startSoc: previous.batterySoc,
          endSoc: current.batterySoc,
          externalEnergy,
          steps: 1,
        };
        continue;
      }

      currentRun.endedAtMs = current.timestampMs;
      currentRun.endSoc = current.batterySoc;
      currentRun.externalEnergy = currentRun.externalEnergy.add(externalEnergy);
      currentRun.steps += 1;
    }

    this.flushRun(currentRun, chargeRuns, dischargeRuns);
    return {chargeRuns, dischargeRuns};
  }

  private classifyInterval(
    averageBatteryPower: Power,
    socDeltaPercent: number,
  ): "charge" | "discharge" | null {
    if (averageBatteryPower.watts < -POWER_THRESHOLD_W && socDeltaPercent >= 0) {
      return "charge";
    }
    if (averageBatteryPower.watts > POWER_THRESHOLD_W && socDeltaPercent <= 0) {
      return "discharge";
    }
    return null;
  }

  private flushRun(
    currentRun: OpenRun | null,
    chargeRuns: EfficiencyRun[],
    dischargeRuns: EfficiencyRun[],
  ): null {
    if (!currentRun) {
      return null;
    }
    const socDelta = currentRun.kind === "charge"
      ? Percentage.fromRatio(currentRun.endSoc.ratio - currentRun.startSoc.ratio)
      : Percentage.fromRatio(currentRun.startSoc.ratio - currentRun.endSoc.ratio);
    if (
      currentRun.steps >= MIN_INTERVAL_STEPS_PER_RUN &&
      socDelta.ratio >= MIN_SOC_DELTA_FRACTION_PER_RUN &&
      currentRun.externalEnergy.kilowattHours >= MIN_EXTERNAL_ENERGY_KWH_PER_RUN
    ) {
      const target = currentRun.kind === "charge" ? chargeRuns : dischargeRuns;
      target.push({
        endedAtMs: currentRun.endedAtMs,
        externalEnergy: currentRun.externalEnergy,
        socDelta,
      });
    }
    return null;
  }

  private estimateChargeEfficiency(runs: EfficiencyRun[], capacity: Energy, nowMs: number): Percentage {
    let numerator = 0;
    let denominator = 0;
    for (const run of runs) {
      const weight = this.recencyWeight(run.endedAtMs, nowMs);
      numerator += weight * run.externalEnergy.kilowattHours * run.socDelta.ratio;
      denominator += weight * run.externalEnergy.kilowattHours * run.externalEnergy.kilowattHours;
    }
    if (!(denominator > 0)) {
      return DEFAULT_CHARGE_EFFICIENCY;
    }
    return clampEfficiency((numerator / denominator) * capacity.kilowattHours);
  }

  private estimateDischargeEfficiency(runs: EfficiencyRun[], capacity: Energy, nowMs: number): Percentage {
    let numerator = 0;
    let denominator = 0;
    for (const run of runs) {
      const weight = this.recencyWeight(run.endedAtMs, nowMs);
      numerator += weight * run.socDelta.ratio * run.externalEnergy.kilowattHours;
      denominator += weight * run.socDelta.ratio * run.socDelta.ratio;
    }
    if (!(denominator > 0)) {
      return DEFAULT_DISCHARGE_EFFICIENCY;
    }
    return clampEfficiency((numerator / denominator) / capacity.kilowattHours);
  }

  private recencyWeight(timestampMs: number, nowMs: number): number {
    const ageDays = Math.max(0, (nowMs - timestampMs) / (24 * 60 * 60 * 1000));
    return Math.exp(-Math.log(2) * ageDays / HALF_LIFE_DAYS);
  }
}

function clampEfficiency(value: number): Percentage {
  if (!Number.isFinite(value)) {
    return DEFAULT_CHARGE_EFFICIENCY;
  }
  return Percentage.fromRatio(
    Math.min(MAX_EFFICIENCY.ratio, Math.max(MIN_EFFICIENCY.ratio, value)),
  );
}
