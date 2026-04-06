import { Inject, Injectable, Logger } from "@nestjs/common";
import { Percentage } from "@chargecaster/domain";

import type { SimulationService } from "../simulation/simulation.service";
import type {
  BatteryControlBackend,
  BatteryControlCapabilities,
  BatteryControlCommand,
} from "./battery-control-backend";
import { BATTERY_CONTROL_BACKEND } from "./battery-control-backend";
import { deriveOperationalMode } from "./optimisation-mode";

type SimulationSnapshot = Awaited<ReturnType<SimulationService["runSimulation"]>>;

const DEFAULT_BATTERY_CONTROL_BACKEND: BatteryControlBackend = {
  getCapabilities(): BatteryControlCapabilities {
    return {
      backendId: "generic-test-backend",
      modeSupport: {
        auto: true,
        holdTargetSoc: true,
        chargeToTargetSoc: true,
        chargeLimitPower: true,
        chargeBoostPower: true,
        absoluteChargeWindow: true,
        recurringScheduleWindow: true,
      },
      autoFloorSocRange: {
        minPercent: 0,
        maxPercent: 100,
        stepPercent: 1,
      },
      targetSocRange: {
        minPercent: 0,
        maxPercent: 100,
        stepPercent: 1,
      },
      chargeLimitPowerRange: {
        minPowerW: 0,
        maxPowerW: null,
        stepPowerW: 1,
        supportsZeroPower: true,
        supportsWindows: true,
      },
      chargeBoostPowerRange: {
        minPowerW: 0,
        maxPowerW: null,
        stepPowerW: 1,
        supportsZeroPower: true,
        supportsWindows: true,
        fixedPowerW: null,
      },
      scheduleConstraints: {
        minWindowMinutes: null,
        maxWindows: null,
      },
    };
  },
  async applyOptimization() {
    return {errorMessage: null};
  },
};

@Injectable()
export class OptimisationCommandTranslator {
  private readonly logger = new Logger(OptimisationCommandTranslator.name);

  constructor(
    @Inject(BATTERY_CONTROL_BACKEND) private readonly batteryControlBackend: BatteryControlBackend = DEFAULT_BATTERY_CONTROL_BACKEND,
  ) {}

  fromSimulationSnapshot(snapshot: SimulationSnapshot): BatteryControlCommand {
    const capabilities = this.batteryControlBackend.getCapabilities();
    const mode = deriveOperationalMode({
      ...snapshot,
      current_soc_percent: this.toPercentage(snapshot.current_soc_percent),
      next_step_soc_percent: this.toPercentage(snapshot.next_step_soc_percent),
    });
    if (mode === "charge") {
      if (!capabilities.modeSupport.chargeToTargetSoc) {
        this.logger.warn("Battery backend does not support charge-to-target mode; falling back to AUTO.");
        return this.buildAutoCommand(snapshot, capabilities);
      }
      const chargeTarget = this.clampSocPercent(this.extractChargeTarget(snapshot), capabilities.targetSocRange);
      const minChargePowerW = this.resolvePreferredBoostPower(capabilities.chargeBoostPowerRange);
      const untilTimestamp = capabilities.modeSupport.absoluteChargeWindow ? this.extractChargeUntil(snapshot) : null;
      if (untilTimestamp || chargeTarget != null || minChargePowerW != null) {
        return {
          charge: {
            targetSocPercent: chargeTarget,
            minChargePowerW,
            ...(untilTimestamp ? {untilTimestamp} : {}),
          },
        };
      }
      return "charge";
    }
    if (mode === "auto") {
      return this.buildAutoCommand(snapshot, capabilities);
    }
    if (mode === "limit") {
      if (!capabilities.modeSupport.chargeLimitPower) {
        this.logger.warn("Battery backend does not support charge limiting; falling back to AUTO.");
        return this.buildAutoCommand(snapshot, capabilities);
      }
      const floor = this.clampSocPercent(this.extractLimitFloor(snapshot), capabilities.autoFloorSocRange);
      const limitRange = capabilities.chargeLimitPowerRange;
      const untilTimestamp = limitRange?.supportsWindows ? this.extractModeUntil(snapshot, "limit") : null;
      return {
        limit: {
          floorSocPercent: floor,
          maxChargePowerW: this.resolveZeroCompatibleLimitPower(limitRange),
          ...(untilTimestamp ? {untilTimestamp} : {}),
        },
      };
    }
    if (!capabilities.modeSupport.holdTargetSoc) {
      this.logger.warn("Battery backend does not support hold-target mode; falling back to AUTO.");
      return this.buildAutoCommand(snapshot, capabilities);
    }
    const observedSoc = this.normalisePercent(snapshot.current_soc_percent);
    const holdTarget = this.clampSocPercent(this.extractHoldTarget(snapshot), capabilities.targetSocRange);
    const floor = this.clampSocPercent(
      this.normalisePercent(snapshot.next_step_soc_percent) ?? holdTarget ?? observedSoc,
      capabilities.autoFloorSocRange,
    );
    const minSoc = this.clampSocPercent(holdTarget ?? observedSoc ?? floor, capabilities.targetSocRange);
    if (minSoc == null) {
      this.logger.warn("Hold strategy missing usable SoC reference; defaulting to AUTO command.");
      return this.buildAutoCommand(snapshot, capabilities);
    }
    return {
      hold: {
        minSocPercent: minSoc,
        observedSocPercent: observedSoc,
        floorSocPercent: floor,
      },
    };
  }

  private buildAutoCommand(
    snapshot: SimulationSnapshot,
    capabilities: BatteryControlCapabilities,
  ): BatteryControlCommand {
    if (!capabilities.modeSupport.auto) {
      this.logger.warn("Battery backend does not support auto mode; falling back to plain AUTO command.");
      return "auto";
    }
    const floor = this.clampSocPercent(this.extractAutoFloor(snapshot), capabilities.autoFloorSocRange);
    if (floor != null) {
      return {auto: {floorSocPercent: floor}};
    }
    return "auto";
  }

  private extractChargeUntil(snapshot: SimulationSnapshot): string | null {
    return this.extractModeUntil(snapshot, "charge");
  }

  private extractModeUntil(
    snapshot: SimulationSnapshot,
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
      const eraEnd = eraEndById.get(entry.era_id);
      if (eraEnd) {
        untilTimestamp = eraEnd;
      }
    }
    return untilTimestamp;
  }

  private extractChargeTarget(snapshot: SimulationSnapshot): number | null {
    const entries = Array.isArray(snapshot.oracle_entries) ? snapshot.oracle_entries : [];
    let target: number | null = null;
    for (const entry of entries) {
      if (entry.strategy !== "charge") {
        break;
      }
      const candidate =
        entry.target_soc_percent ?? entry.end_soc_percent ?? entry.start_soc_percent ?? null;
      const normalised = this.normalisePercent(candidate);
      if (normalised != null) {
        target = normalised;
      }
    }
    return target
      ?? this.normalisePercent(snapshot.next_step_soc_percent)
      ?? this.normalisePercent(snapshot.current_soc_percent);
  }

  private extractHoldTarget(snapshot: SimulationSnapshot): number | null {
    if (Array.isArray(snapshot.oracle_entries)) {
      const holdEntry = snapshot.oracle_entries.find((entry) => entry.strategy === "hold");
      if (holdEntry) {
        const candidate =
          holdEntry.target_soc_percent ?? holdEntry.end_soc_percent ?? holdEntry.start_soc_percent ?? null;
        const normalised = this.normalisePercent(candidate);
        if (normalised != null) {
          return normalised;
        }
      }
    }
    return this.normalisePercent(snapshot.next_step_soc_percent) ?? this.normalisePercent(snapshot.current_soc_percent);
  }

  private extractAutoFloor(snapshot: SimulationSnapshot): number | null {
    return this.normalisePercent(snapshot.next_step_soc_percent);
  }

  private extractLimitFloor(snapshot: SimulationSnapshot): number | null {
    return this.normalisePercent(snapshot.next_step_soc_percent) ?? this.normalisePercent(snapshot.current_soc_percent);
  }

  private clampSocPercent(value: number | null, range: BatteryControlCapabilities["autoFloorSocRange"]): number | null {
    if (value == null) {
      return null;
    }
    const bounded = Math.min(range.maxPercent, Math.max(range.minPercent, value));
    if (range.stepPercent == null || range.stepPercent <= 0) {
      return bounded;
    }
    return Math.round(bounded / range.stepPercent) * range.stepPercent;
  }

  private resolveZeroCompatibleLimitPower(
    range: BatteryControlCapabilities["chargeLimitPowerRange"],
  ): number | null {
    if (!range) {
      return 0;
    }
    if (range.supportsZeroPower) {
      return 0;
    }
    return range.minPowerW;
  }

  private resolvePreferredBoostPower(
    range: BatteryControlCapabilities["chargeBoostPowerRange"],
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

  private normalisePercent(value: unknown): number | null {
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

  private toPercentage(value: unknown): Percentage | null {
    const normalised = this.normalisePercent(value);
    return normalised == null ? null : Percentage.fromPercent(normalised);
  }
}
