import { Percentage } from "@chargecaster/domain";

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
  if (snapshot.current_mode) {
    return snapshot.current_mode;
  }

  const entries = Array.isArray(snapshot.oracle_entries) ? snapshot.oracle_entries : [];
  if (entries.length > 0) {
    return entries[0].strategy;
  }

  const currentSoc = normalisePercent(snapshot.current_soc_percent);
  const nextSoc = normalisePercent(snapshot.next_step_soc_percent);
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

function normalisePercent(value: unknown): number | null {
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
