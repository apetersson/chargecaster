import { Injectable, Logger } from "@nestjs/common";

import type { OptimisationCommand } from "../fronius/fronius.service";
import type { SimulationService } from "../simulation/simulation.service";

type SimulationSnapshot = Awaited<ReturnType<SimulationService["runSimulation"]>>;

@Injectable()
export class OptimisationCommandTranslator {
  private readonly logger = new Logger(OptimisationCommandTranslator.name);

  fromSimulationSnapshot(snapshot: SimulationSnapshot): OptimisationCommand {
    const mode = snapshot.current_mode;
    if (mode === "charge") {
      return "charge";
    }
    if (mode === "auto") {
      const floor = this.extractAutoFloor(snapshot);
      if (floor != null) {
        return {auto: {floorSocPercent: floor}};
      }
      return "auto";
    }
    if (mode === "hold") {
      const observedSoc = this.normalisePercent(snapshot.current_soc_percent);
      const holdTarget = this.extractHoldTarget(snapshot);
      const floor = this.normalisePercent(snapshot.next_step_soc_percent) ?? holdTarget ?? observedSoc;
      const minSoc = holdTarget ?? observedSoc ?? floor;
      if (minSoc == null) {
        this.logger.warn("Hold strategy missing usable SoC reference; defaulting to AUTO command.");
        return "auto";
      }
      return {
        hold: {
          minSocPercent: minSoc,
          observedSocPercent: observedSoc,
          floorSocPercent: floor,
        },
      };
    }
    return "auto";
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

  private normalisePercent(value: unknown): number | null {
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
