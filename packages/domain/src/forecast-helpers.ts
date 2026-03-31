import { Duration } from "./duration";
import { Energy } from "./energy";
import { powerFromEnergy } from "./battery-math";
import { Percentage } from "./percentage";
import { Power } from "./power";
import { EnergyPrice } from "./price";
import type {
  ForecastEra,
  OracleEntry,
  PriceSlot,
  RawForecastEntry,
} from "./simulation";
import { TariffSlot } from "./tariff-slot";
import { TimeSlot } from "./time-slot";
import { parseTemporal } from "./solar-timeseries";

const DEFAULT_SLOT_DURATION = Duration.fromHours(1);
const DEFAULT_SLOT_DURATION_MS = 3_600_000;

export interface ForecastDerivedEra {
  era: ForecastEra;
  oracle?: OracleEntry;
  slot: TimeSlot;
  price: EnergyPrice | null;
  solarEnergy: Energy | null;
  solarAveragePower: Power | null;
  demandPower: Power;
  gridPower: Power | null;
  targetSoc: Percentage | null;
  strategy: OracleEntry["strategy"] | null;
}

function resolveSlotDuration(entry: RawForecastEntry, start: Date, explicitEnd: Date | null): Duration | null {
  if (explicitEnd && explicitEnd.getTime() > start.getTime()) {
    const between = Duration.between(start, explicitEnd);
    return between.milliseconds > 0 ? between : null;
  }

  const hoursValue = Number(entry.duration_hours ?? entry.durationHours ?? Number.NaN);
  if (Number.isFinite(hoursValue) && hoursValue > 0) {
    return Duration.fromHours(hoursValue);
  }

  const minutesValue = Number(entry.duration_minutes ?? entry.durationMinutes ?? Number.NaN);
  if (Number.isFinite(minutesValue) && minutesValue > 0) {
    return Duration.fromMinutes(minutesValue);
  }

  return null;
}

export function normalizePriceSlots(raw: RawForecastEntry[]): PriceSlot[] {
  const slotsByStart = new Map<number, TariffSlot>();

  for (const entry of raw) {
    const start = parseTemporal(entry.start ?? entry.from ?? null);
    if (!start) {
      continue;
    }

    const explicitEnd = parseTemporal(entry.end ?? entry.to ?? null);
    const slotDuration = resolveSlotDuration(entry, start, explicitEnd) ?? DEFAULT_SLOT_DURATION;
    if (slotDuration.milliseconds === 0) {
      continue;
    }

    const energyPrice =
      EnergyPrice.tryFromValue(entry.price, entry.unit) ??
      EnergyPrice.tryFromValue(entry.value, entry.value_unit);
    if (!energyPrice) {
      continue;
    }

    const rawEraId = entry.era_id ?? entry.eraId;
    const eraId = typeof rawEraId === "string" && rawEraId.length > 0 ? rawEraId : undefined;
    const slot = TariffSlot.fromTimeSlot(TimeSlot.fromStartAndDuration(start, slotDuration), energyPrice, eraId);
    const key = slot.start.getTime();
    const existing = slotsByStart.get(key);
    if (!existing || slot.energyPrice.eurPerKwh < existing.energyPrice.eurPerKwh) {
      slotsByStart.set(key, slot);
    }
  }

  return [...slotsByStart.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
}

export function derivePriceSnapshot(
  slots: PriceSlot[],
  gridFee: EnergyPrice = EnergyPrice.fromEurPerKwh(0),
  referenceTimeMs = Date.now(),
): EnergyPrice | null {
  const activeOrUpcomingSlot = slots.find((slot) => slot.end.getTime() > referenceTimeMs) ?? null;
  if (!activeOrUpcomingSlot) {
    return null;
  }
  return activeOrUpcomingSlot.energyPrice.withAdditionalFee(gridFee.eurPerKwh);
}

export function buildOracleLookup(entries: OracleEntry[]): Map<string, OracleEntry> {
  const lookup = new Map<string, OracleEntry>();
  for (const entry of entries) {
    if (entry.era_id.length === 0) {
      continue;
    }
    lookup.set(entry.era_id, entry);
    const timestamp = parseTemporal(entry.era_id);
    if (timestamp) {
      lookup.set(String(timestamp.getTime()), entry);
    }
  }
  return lookup;
}

export function resolveOracleEntryForEra(
  era: ForecastEra,
  lookup: Map<string, OracleEntry>,
): OracleEntry | undefined {
  if (era.era_id.length > 0) {
    const direct = lookup.get(era.era_id);
    if (direct) {
      return direct;
    }
    const normalizedEraId = parseTemporal(era.era_id);
    if (normalizedEraId) {
      const byEraIdTimestamp = lookup.get(String(normalizedEraId.getTime()));
      if (byEraIdTimestamp) {
        return byEraIdTimestamp;
      }
    }
  }

  const startTimestamp = parseTemporal(era.start);
  if (startTimestamp) {
    const byStart = lookup.get(String(startTimestamp.getTime()));
    if (byStart) {
      return byStart;
    }
  }

  return undefined;
}

export function derivePowerFromEnergy(
  energy: Energy | null | undefined,
  duration: Duration | null | undefined,
): Power | null {
  if (!(energy instanceof Energy) || !(duration instanceof Duration) || duration.milliseconds <= 0) {
    return null;
  }
  return powerFromEnergy(energy, duration);
}

export function extractForecastEraPrice(era: ForecastEra): EnergyPrice | null {
  const costSource = era.sources.find(
    (source): source is Extract<ForecastEra["sources"][number], { type: "cost" }> =>
      source.type === "cost" && source.provider === "canonical",
  ) ?? era.sources.find(
    (source): source is Extract<ForecastEra["sources"][number], { type: "cost" }> => source.type === "cost",
  );
  if (!costSource) {
    return null;
  }

  if (Number.isFinite(costSource.payload.price_with_fee_eur_per_kwh)) {
    return EnergyPrice.fromEurPerKwh(costSource.payload.price_with_fee_eur_per_kwh);
  }
  if (Number.isFinite(costSource.payload.price_with_fee_ct_per_kwh)) {
    return EnergyPrice.fromCentsPerKwh(costSource.payload.price_with_fee_ct_per_kwh);
  }
  if (Number.isFinite(costSource.payload.price_eur_per_kwh)) {
    return EnergyPrice.fromEurPerKwh(costSource.payload.price_eur_per_kwh);
  }
  if (Number.isFinite(costSource.payload.price_ct_per_kwh)) {
    return EnergyPrice.fromCentsPerKwh(costSource.payload.price_ct_per_kwh);
  }

  return null;
}

export function extractForecastEraSolar(
  era: ForecastEra,
  slot: TimeSlot | null,
): { energy: Energy | null; averagePower: Power | null } {
  const solarSource = era.sources.find(
    (source): source is Extract<ForecastEra["sources"][number], { type: "solar" }> => source.type === "solar",
  );
  if (!solarSource) {
    return { energy: null, averagePower: null };
  }

  const energy = Number.isFinite(solarSource.payload.energy_wh)
    ? Energy.fromWattHours(solarSource.payload.energy_wh)
    : null;
  const averagePower = typeof solarSource.payload.average_power_w === "number" && Number.isFinite(solarSource.payload.average_power_w)
    ? Power.fromWatts(solarSource.payload.average_power_w)
    : energy && slot
      ? energy.divideByDuration(slot.duration)
      : null;

  return { energy, averagePower };
}

function extractTargetSoc(entry: OracleEntry | undefined): Percentage | null {
  const percent = entry?.end_soc_percent ?? entry?.target_soc_percent ?? null;
  if (typeof percent !== "number" || !Number.isFinite(percent)) {
    return null;
  }
  return Percentage.fromPercent(percent);
}

export function buildDerivedForecastEras(
  forecast: ForecastEra[],
  oracleEntries: OracleEntry[],
  summary?: unknown,
  now = Date.now(),
): ForecastDerivedEra[] {
  void summary;
  const oracleLookup = buildOracleLookup(oracleEntries);
  const derived: ForecastDerivedEra[] = [];

  for (const era of forecast) {
    const startDate = parseTemporal(era.start);
    if (!startDate) {
      continue;
    }

    const rawEndDate = parseTemporal(era.end);
    const startMs = startDate.getTime();
    const endMs = rawEndDate?.getTime() ?? startMs + DEFAULT_SLOT_DURATION_MS;
    if (endMs <= Math.max(startMs, now)) {
      continue;
    }

    let slot: TimeSlot;
    try {
      slot = TimeSlot.fromDates(startDate, new Date(endMs));
    } catch (error) {
      void error;
      continue;
    }

    const oracle = resolveOracleEntryForEra(era, oracleLookup);
    const solar = extractForecastEraSolar(era, slot);
    const gridEnergy = typeof oracle?.grid_energy_wh === "number" && Number.isFinite(oracle.grid_energy_wh)
      ? Energy.fromWattHours(oracle.grid_energy_wh)
      : null;

    derived.push({
      era,
      oracle,
      slot,
      price: extractForecastEraPrice(era),
      solarEnergy: solar.energy,
      solarAveragePower: solar.averagePower,
      demandPower: Power.zero(),
      gridPower: derivePowerFromEnergy(gridEnergy, slot.duration),
      targetSoc: extractTargetSoc(oracle),
      strategy: oracle?.strategy ?? null,
    });
  }

  return derived.sort((a, b) => a.slot.start.getTime() - b.slot.start.getTime());
}
