import { Percentage } from "@chargecaster/domain";
import { resolvePlannedBatteryControlMode } from "./battery-control-backend";

type Mode = "charge" | "auto" | "hold" | "limit";

type OracleLikeEntry = {
  strategy: Mode;
};

export interface OptimisationSnapshotLike {
  current_mode?: Mode | null;
  current_soc_percent?: Percentage | null;
  next_step_soc_percent?: Percentage | null;
  oracle_entries?: OracleLikeEntry[] | null;
}

export function deriveOperationalMode(snapshot: OptimisationSnapshotLike): Mode {
  return resolvePlannedBatteryControlMode(snapshot);
}
