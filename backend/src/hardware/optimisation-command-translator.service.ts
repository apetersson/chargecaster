import { Inject, Injectable, Logger } from "@nestjs/common";

import type { SimulationService } from "../simulation/simulation.service";
import type {
  BatteryControlBackend,
  BatteryControlCapabilities,
  BatteryControlCommand,
} from "./battery-control-backend";
import {
  BATTERY_CONTROL_BACKEND,
  buildGenericBatteryControlCapabilities,
  getBatteryControlModeDefinition,
  resolvePlannedBatteryControlMode,
} from "./battery-control-backend";

type SimulationSnapshot = Awaited<ReturnType<SimulationService["runSimulation"]>>;

const DEFAULT_BATTERY_CONTROL_BACKEND: BatteryControlBackend = {
  getCapabilities(): BatteryControlCapabilities {
    return buildGenericBatteryControlCapabilities();
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
    const mode = resolvePlannedBatteryControlMode(snapshot);
    const modeDefinition = getBatteryControlModeDefinition(capabilities, mode);
    if (!modeDefinition?.buildCommandFromSnapshot) {
      this.logger.warn(`Battery backend does not support ${mode} mode; falling back to AUTO.`);
      return this.buildAutoCommand(snapshot, capabilities);
    }

    const command = modeDefinition.buildCommandFromSnapshot(snapshot);
    if (command) {
      return command;
    }

    this.logger.warn(`${mode} mode could not build a usable command from the snapshot; falling back to AUTO.`);
    return this.buildAutoCommand(snapshot, capabilities);
  }

  private buildAutoCommand(
    snapshot: SimulationSnapshot,
    capabilities: BatteryControlCapabilities,
  ): BatteryControlCommand {
    const autoMode = getBatteryControlModeDefinition(capabilities, "auto");
    if (!autoMode?.buildCommandFromSnapshot) {
      this.logger.warn("Battery backend does not support auto mode; falling back to plain AUTO command.");
      return "auto";
    }
    return autoMode.buildCommandFromSnapshot(snapshot) ?? "auto";
  }
}
