import { Inject, Injectable, Logger } from "@nestjs/common";
import { Percentage, type BatteryControlMode } from "@chargecaster/domain";

import type { SimulationService } from "../simulation/simulation.service";
import type {
  BatteryControlBackend,
  BatteryControlCapabilities,
  BatteryControlCommand,
  BatteryControlModeDefinition,
} from "./battery-control-backend";
import { BATTERY_CONTROL_BACKEND, getBatteryControlModeDefinition } from "./battery-control-backend";

type SimulationSnapshot = Awaited<ReturnType<SimulationService["runSimulation"]>>;

const DEFAULT_BATTERY_CONTROL_BACKEND: BatteryControlBackend = {
  getCapabilities(): BatteryControlCapabilities {
    return {
      backendId: "generic-test-backend",
      modes: [
        {
          id: "auto",
          floorSocRange: {minPercent: 0, maxPercent: 100, stepPercent: 1},
        },
        {
          id: "hold",
          floorSocRange: {minPercent: 0, maxPercent: 100, stepPercent: 1},
          targetSocRange: {minPercent: 0, maxPercent: 100, stepPercent: 1},
        },
        {
          id: "limit",
          floorSocRange: {minPercent: 0, maxPercent: 100, stepPercent: 1},
          maxChargePowerRange: {
            minPowerW: 0,
            maxPowerW: null,
            stepPowerW: 1,
            supportsZeroPower: true,
            supportsWindows: true,
          },
        },
        {
          id: "charge",
          targetSocRange: {minPercent: 0, maxPercent: 100, stepPercent: 1},
          minChargePowerRange: {
            minPowerW: 0,
            maxPowerW: null,
            stepPowerW: 1,
            supportsZeroPower: true,
            supportsWindows: true,
            fixedPowerW: null,
          },
        },
      ],
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
    const mode = this.resolvePlannedMode(snapshot);
    if (mode === "charge") {
      const chargeMode = getBatteryControlModeDefinition(capabilities, "charge");
      if (!chargeMode) {
        this.logger.warn("Battery backend does not support charge mode; falling back to AUTO.");
        return this.buildAutoCommand(snapshot, capabilities);
      }
      const chargeTarget = this.clampSocPercent(this.extractChargeTarget(snapshot), chargeMode.targetSocRange ?? null);
      const minChargePowerW = this.resolvePreferredBoostPower(chargeMode.minChargePowerRange ?? null);
      const untilTimestamp = chargeMode.minChargePowerRange?.supportsWindows ? this.extractChargeUntil(snapshot) : null;
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
      const limitMode = getBatteryControlModeDefinition(capabilities, "limit");
      if (!limitMode) {
        this.logger.warn("Battery backend does not support charge limiting; falling back to AUTO.");
        return this.buildAutoCommand(snapshot, capabilities);
      }
      const floor = this.clampSocPercent(this.extractLimitFloor(snapshot), limitMode.floorSocRange ?? null);
      const limitRange = limitMode.maxChargePowerRange ?? null;
      const untilTimestamp = limitRange?.supportsWindows ? this.extractModeUntil(snapshot, "limit") : null;
      return {
        limit: {
          floorSocPercent: floor,
          maxChargePowerW: this.resolveZeroCompatibleLimitPower(limitRange),
          ...(untilTimestamp ? {untilTimestamp} : {}),
        },
      };
    }
    const holdMode = getBatteryControlModeDefinition(capabilities, "hold");
    if (!holdMode) {
      this.logger.warn("Battery backend does not support hold-target mode; falling back to AUTO.");
      return this.buildAutoCommand(snapshot, capabilities);
    }
    const observedSoc = this.normalisePercent(snapshot.current_soc_percent);
    const holdTarget = this.clampSocPercent(this.extractHoldTarget(snapshot), holdMode.targetSocRange ?? null);
    const floor = this.clampSocPercent(
      this.normalisePercent(snapshot.next_step_soc_percent) ?? holdTarget ?? observedSoc,
      holdMode.floorSocRange ?? null,
    );
    const minSoc = this.clampSocPercent(holdTarget ?? observedSoc ?? floor, holdMode.targetSocRange ?? null);
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
    const autoMode = getBatteryControlModeDefinition(capabilities, "auto");
    if (!autoMode) {
      this.logger.warn("Battery backend does not support auto mode; falling back to plain AUTO command.");
      return "auto";
    }
    const floor = this.clampSocPercent(this.extractAutoFloor(snapshot), autoMode.floorSocRange ?? null);
    if (floor != null) {
      return {auto: {floorSocPercent: floor}};
    }
    return "auto";
  }

  private resolvePlannedMode(snapshot: SimulationSnapshot): BatteryControlMode {
    if (snapshot.current_mode) {
      return snapshot.current_mode;
    }
    if (Array.isArray(snapshot.oracle_entries) && snapshot.oracle_entries.length > 0) {
      return snapshot.oracle_entries[0]?.strategy ?? "auto";
    }
    const currentSoc = this.normalisePercent(snapshot.current_soc_percent);
    const nextSoc = this.normalisePercent(snapshot.next_step_soc_percent);
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
      const candidate = entry.target_soc_percent ?? entry.end_soc_percent ?? entry.start_soc_percent ?? null;
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
        const candidate = holdEntry.target_soc_percent ?? holdEntry.end_soc_percent ?? holdEntry.start_soc_percent ?? null;
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

  private clampSocPercent(
    value: number | null,
    range: BatteryControlModeDefinition["floorSocRange"] | BatteryControlModeDefinition["targetSocRange"] | null,
  ): number | null {
    if (value == null || !range) {
      return value;
    }
    const bounded = Math.min(range.maxPercent, Math.max(range.minPercent, value));
    if (range.stepPercent == null || range.stepPercent <= 0) {
      return bounded;
    }
    return Math.round(bounded / range.stepPercent) * range.stepPercent;
  }

  private resolveZeroCompatibleLimitPower(
    range: BatteryControlModeDefinition["maxChargePowerRange"] | null,
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
}
