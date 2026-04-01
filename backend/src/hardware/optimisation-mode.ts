import { Percentage } from "@chargecaster/domain";

type Mode = "charge" | "auto" | "hold" | "limit";

type OracleLikeEntry = {
  era_id: string;
  start_soc_percent?: number | null;
  end_soc_percent?: number | null;
  target_soc_percent?: number | null;
  grid_energy_wh?: number | null;
  strategy: Mode;
};

type ForecastEraLike = {
  era_id: string;
  duration_hours?: number | null;
};

export interface OptimisationSnapshotLike {
  current_mode?: Mode | null;
  current_soc_percent?: Percentage | null;
  next_step_soc_percent?: Percentage | null;
  oracle_entries?: OracleLikeEntry[] | null;
  forecast_eras?: ForecastEraLike[] | null;
}

const MIN_MEANINGFUL_CHARGE_POWER_W = 1000;
const MIN_MEANINGFUL_CHARGE_ENERGY_WH = 750;
const MAX_TRANSIENT_HOLD_HOURS = 1;
const MIN_TARGET_DELTA_PERCENT = 1;

export function deriveOperationalMode(snapshot: OptimisationSnapshotLike): Mode {
  const rawMode = deriveRawMode(snapshot);
  if (rawMode === "charge") {
    // The DP can label an era as "charge" even when the practical intent is
    // still gentle PV-led charging. Only surface a hard charge mode when the
    // immediate plan really calls for meaningful grid energy right now.
    return hasMeaningfulImmediateGridCharge(snapshot) ? "charge" : "auto";
  }
  if (rawMode === "hold") {
    // Short "hold" bridges before a rising SoC path should not kick the
    // inverter out of auto during sunny hours; treat those transient holds as
    // auto so PV charging can continue naturally.
    return shouldRelaxHoldToAuto(snapshot) ? "auto" : "hold";
  }
  return rawMode;
}

function deriveRawMode(snapshot: OptimisationSnapshotLike): Mode {
  if (snapshot.current_mode) {
    return snapshot.current_mode;
  }

  const entries = getEntries(snapshot);
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

function hasMeaningfulImmediateGridCharge(snapshot: OptimisationSnapshotLike): boolean {
  const eraDurationHours = new Map(
    getForecastEras(snapshot)
      .filter((era) => typeof era.era_id === "string" && era.era_id.length > 0)
      .map((era) => [era.era_id, normalisePositiveNumber(era.duration_hours) ?? 1]),
  );

  // Fronius "charge" is an actuator-level command, so require enough planned
  // grid energy to justify leaving auto mode instead of reacting to tiny DP
  // top-up amounts.
  let totalGridChargeWh = 0;
  for (const entry of getEntries(snapshot)) {
    if (entry.strategy !== "charge") {
      break;
    }

    const gridChargeWh = Math.max(0, Number(entry.grid_energy_wh ?? 0));
    totalGridChargeWh += gridChargeWh;
    const durationHours = eraDurationHours.get(entry.era_id) ?? 1;
    const averageChargePowerW = durationHours > 0 ? gridChargeWh / durationHours : 0;
    if (averageChargePowerW >= MIN_MEANINGFUL_CHARGE_POWER_W) {
      return true;
    }
  }

  return totalGridChargeWh >= MIN_MEANINGFUL_CHARGE_ENERGY_WH;
}

function shouldRelaxHoldToAuto(snapshot: OptimisationSnapshotLike): boolean {
  const entries = getEntries(snapshot);
  if (!entries.length || entries[0].strategy !== "hold") {
    return false;
  }

  const eraDurationHours = new Map(
    getForecastEras(snapshot)
      .filter((era) => typeof era.era_id === "string" && era.era_id.length > 0)
      .map((era) => [era.era_id, normalisePositiveNumber(era.duration_hours) ?? 1]),
  );

  let holdDurationHours = 0;
  let holdTarget = extractTargetSoc(entries[0]);
  let index = 0;
  for (; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.strategy !== "hold") {
      break;
    }
    holdDurationHours += eraDurationHours.get(entry.era_id) ?? 1;
    holdTarget = extractTargetSoc(entry) ?? holdTarget;
  }

  if (holdDurationHours > MAX_TRANSIENT_HOLD_HOURS) {
    return false;
  }

  const lookAheadEntries = entries.slice(index, index + 3);
  return lookAheadEntries.some((entry) => {
    if (entry.strategy !== "auto" && entry.strategy !== "charge") {
      return false;
    }
    const target = extractTargetSoc(entry);
    if (target == null || holdTarget == null) {
      return true;
    }
    return target >= holdTarget + MIN_TARGET_DELTA_PERCENT;
  });
}

function extractTargetSoc(entry: OracleLikeEntry | undefined): number | null {
  if (!entry) {
    return null;
  }
  return normalisePercent(entry.target_soc_percent ?? entry.end_soc_percent ?? entry.start_soc_percent ?? null);
}

function getEntries(snapshot: OptimisationSnapshotLike): OracleLikeEntry[] {
  return Array.isArray(snapshot.oracle_entries) ? snapshot.oracle_entries : [];
}

function getForecastEras(snapshot: OptimisationSnapshotLike): ForecastEraLike[] {
  return Array.isArray(snapshot.forecast_eras) ? snapshot.forecast_eras : [];
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

function normalisePositiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}
