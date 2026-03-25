import { randomUUID } from "node:crypto";
import { Injectable, Logger } from "@nestjs/common";

import type { ForecastEra, RawForecastEntry, RawSolarEntry, SimulationConfig } from "@chargecaster/domain";
import { derivePriceSnapshot, EnergyPrice, normalizePriceSlots, TimeSlot } from "@chargecaster/domain";
import { parseTimestamp } from "../simulation/solar";
import type { PriceProviderForecast } from "./market-data.service";

const SLOT_DURATION_MS = 3_600_000;

type MutableRecord = Record<string, unknown>;

type CostSource = Extract<ForecastEra["sources"][number], { type: "cost" }>;
type SolarSource = Extract<ForecastEra["sources"][number], { type: "solar" }>;

interface NormalizedSlot {
  payload: MutableRecord;
  startDate: Date | null;
  endDate: Date | null;
  startIso: string | null;
  endIso: string | null;
  durationHours: number | null;
  timeSlot: TimeSlot | null;
}

interface EraEntry {
  slot: NormalizedSlot;
  payload: MutableRecord & { era_id: string };
  sources: ForecastEra["sources"];
}

interface ReferenceForecastIndex {
  provider: string;
  priority: number;
  slots: Map<string, MutableRecord>;
}

@Injectable()
export class ForecastAssemblyService {
  private readonly logger = new Logger(ForecastAssemblyService.name);

  buildForecastEras(
    canonicalForecast: RawForecastEntry[],
    providerForecasts: PriceProviderForecast[],
    solarForecast: RawSolarEntry[],
    gridFeeEurPerKwh: number,
  ): { forecastEntries: RawForecastEntry[]; eras: ForecastEra[] } {
    if (!canonicalForecast.length) {
      return {forecastEntries: [], eras: []};
    }

    const canonicalSlots = this.dedupeSlots(
      canonicalForecast
        .map((entry) => this.normalizeForecastSlot(entry))
        .filter((slot) => slot.startIso !== null),
    );

    const referenceIndices = providerForecasts
      .map((providerForecast) => ({
        provider: providerForecast.key,
        priority: providerForecast.priority,
        slots: this.buildStartIndex(providerForecast.forecast),
      }))
      .sort((left, right) => left.priority - right.priority);

    const solarSlots = this.dedupeSlots(
      solarForecast
        .map((entry) => this.normalizeForecastSlot(entry))
        .filter((slot) => slot.startDate !== null),
    );

    const eraMap = new Map<string, EraEntry>();

    for (const slot of canonicalSlots) {
      if (!slot.startIso) {
        continue;
      }
      let entry = eraMap.get(slot.startIso);
      if (!entry) {
        const eraId = randomUUID();
        entry = {
          slot,
          payload: {...slot.payload, era_id: eraId} as MutableRecord & { era_id: string },
          sources: [],
        };
        eraMap.set(slot.startIso, entry);
      }

      const baseCost = this.applySlotPrice(entry, slot.payload, gridFeeEurPerKwh);
      if (baseCost) {
        const canonicalSource: CostSource = {
          provider: "canonical",
          type: "cost",
          payload: baseCost,
        };
        this.addSource(entry, canonicalSource);
      }

      for (const reference of referenceIndices) {
        const referencePayload = reference.slots.get(slot.startIso);
        if (!referencePayload) {
          continue;
        }
        const referenceCost = this.buildSourcePayload(referencePayload, gridFeeEurPerKwh);
        if (!referenceCost) {
          continue;
        }
        const provider = typeof referencePayload.provider === "string" && referencePayload.provider.length > 0
          ? referencePayload.provider
          : reference.provider;
        const source: CostSource = {
          provider,
          type: "cost",
          payload: referenceCost,
        };
        this.addSource(entry, source);
      }

      const solarSlot = this.findSolarSlot(slot.startDate, slot.endDate, solarSlots);
      const solarProvider = typeof solarSlot?.payload.provider === "string" && solarSlot.payload.provider.length > 0
        ? solarSlot.payload.provider
        : "open_meteo";
      const solarSource = this.buildSolarSource(solarProvider, slot, solarSlot);
      if (solarSource) {
        this.addSource(entry, solarSource);
      }
    }

    const sorted = [...eraMap.entries()].sort((a, b) => {
      const aStart = parseTimestamp(a[0])?.getTime() ?? 0;
      const bStart = parseTimestamp(b[0])?.getTime() ?? 0;
      return aStart - bStart;
    });

    const forecastEntries: RawForecastEntry[] = [];
    const eras: ForecastEra[] = [];
    for (const [, value] of sorted) {
      forecastEntries.push(structuredClone(value.slot.payload) as RawForecastEntry);
      eras.push({
        era_id: value.payload.era_id,
        start: value.slot.startIso ?? undefined,
        end: value.slot.endIso ?? undefined,
        duration_hours: value.slot.durationHours,
        sources: value.sources.map((source: CostSource | SolarSource) =>
          source.type === "cost"
            ? {
                provider: source.provider,
                type: "cost",
                payload: structuredClone(source.payload),
              }
            : {
                provider: source.provider,
                type: "solar",
                payload: structuredClone(source.payload),
              },
        ),
      });
    }

    return {forecastEntries, eras};
  }

  derivePriceSnapshot(forecast: RawForecastEntry[], config: SimulationConfig): number | null {
    return derivePriceSnapshot(
      normalizePriceSlots(forecast),
      EnergyPrice.fromEurPerKwh(config.price.grid_fee_eur_per_kwh ?? 0),
    )?.eurPerKwh ?? null;
  }

  private addSource(entry: EraEntry, source: CostSource | SolarSource): void {
    const exists = entry.sources.some((item: CostSource | SolarSource) => item.provider === source.provider && item.type === source.type);
    if (!exists) {
      if (source.type === "cost") {
        entry.sources.push({
          provider: source.provider,
          type: "cost",
          payload: structuredClone(source.payload),
        });
      } else {
        entry.sources.push({
          provider: source.provider,
          type: "solar",
          payload: structuredClone(source.payload),
        });
      }
    }
  }

  private applySlotPrice(
    entry: EraEntry,
    sourcePayload: MutableRecord,
    gridFeeEur: number,
  ): CostSource["payload"] | null {
    const payload = this.buildSourcePayload(sourcePayload, gridFeeEur);
    if (!payload) {
      return null;
    }

    entry.slot.payload.price = payload.price_eur_per_kwh;
    entry.slot.payload.unit = "EUR/kWh";
    entry.slot.payload.price_ct_per_kwh = payload.price_ct_per_kwh;
    entry.slot.payload.price_eur_per_kwh = payload.price_eur_per_kwh;
    entry.slot.payload.price_with_fee_ct_per_kwh = payload.price_with_fee_ct_per_kwh;
    entry.slot.payload.price_with_fee_eur_per_kwh = payload.price_with_fee_eur_per_kwh;

    entry.payload.price = payload.price_eur_per_kwh;
    entry.payload.unit = "EUR/kWh";
    entry.payload.price_ct_per_kwh = payload.price_ct_per_kwh;
    entry.payload.price_with_fee_ct_per_kwh = payload.price_with_fee_ct_per_kwh;
    entry.payload.price_with_fee_eur_per_kwh = payload.price_with_fee_eur_per_kwh;

    return payload;
  }

  private buildSourcePayload(
    sourcePayload: MutableRecord,
    gridFeeEur: number,
  ): CostSource["payload"] | null {
    const {priceValue, unitValue} = this.resolvePriceFields(sourcePayload);
    const energyPrice = this.parseEnergyPrice(priceValue, unitValue);
    if (!energyPrice) {
      return null;
    }
    const totalPrice = energyPrice.withAdditionalFee(gridFeeEur);
    return {
      price_ct_per_kwh: energyPrice.ctPerKwh,
      price_eur_per_kwh: energyPrice.eurPerKwh,
      price_with_fee_ct_per_kwh: totalPrice.ctPerKwh,
      price_with_fee_eur_per_kwh: totalPrice.eurPerKwh,
      unit: "ct/kWh",
    };
  }

  private buildSolarSource(provider: string, eraSlot: NormalizedSlot, solarSlot: NormalizedSlot | undefined): SolarSource | null {
    if (!solarSlot) {
      return null;
    }
    let energyWh = this.toNumber(solarSlot.payload.energy_wh);
    if (energyWh === null) {
      const energyKwh = this.toNumber(solarSlot.payload.energy_kwh);
      if (energyKwh !== null) {
        energyWh = energyKwh * 1000;
      }
    }
    if (energyWh === null || energyWh <= 0) {
      return null;
    }

    const eraStart = eraSlot.startDate?.getTime();
    const eraEnd = eraSlot.endDate?.getTime();
    const solarStart = solarSlot.startDate?.getTime();
    const solarEnd = solarSlot.endDate?.getTime();

    if (!eraStart || !eraEnd || !solarStart || !solarEnd) {
      return {provider, type: "solar", payload: {energy_wh: energyWh}};
    }

    const overlapMs = Math.max(0, Math.min(eraEnd, solarEnd) - Math.max(eraStart, solarStart));
    if (overlapMs <= 0) {
      return null;
    }
    const solarSlotMs = Math.max(1, solarEnd - solarStart);
    const overlapRatio = overlapMs / solarSlotMs;
    const scaledEnergyWh = energyWh * overlapRatio;

    const eraDurationHours = eraSlot.timeSlot?.duration.hours ?? eraSlot.durationHours ?? null;
    const averagePower = eraDurationHours && eraDurationHours > 0 ? scaledEnergyWh / eraDurationHours : undefined;
    return averagePower !== undefined
      ? {provider, type: "solar", payload: {energy_wh: scaledEnergyWh, average_power_w: averagePower}}
      : {provider, type: "solar", payload: {energy_wh: scaledEnergyWh}};
  }

  private findSolarSlot(startDate: Date | null, endDate: Date | null, slots: NormalizedSlot[]): NormalizedSlot | undefined {
    if (!startDate) {
      return undefined;
    }
    const startIso = startDate.toISOString();
    const direct = slots.find((slot) => slot.startIso === startIso);
    if (direct) {
      return direct;
    }
    const startTime = startDate.getTime();
    const endTime = endDate?.getTime() ?? startTime + SLOT_DURATION_MS;
    for (const slot of slots) {
      const slotStart = slot.startDate?.getTime();
      if (slotStart === undefined) {
        continue;
      }
      const slotEnd = slot.endDate?.getTime() ?? slotStart + SLOT_DURATION_MS;
      if (slotStart < endTime && slotEnd > startTime) {
        return slot;
      }
    }
    return undefined;
  }

  private buildStartIndex(entries: RawForecastEntry[]): Map<string, MutableRecord> {
    const index = new Map<string, MutableRecord>();
    for (const entry of entries) {
      const slot = this.normalizeForecastSlot(entry);
      if (!slot.startIso) {
        continue;
      }
      index.set(slot.startIso, slot.payload);
    }
    return index;
  }

  private dedupeSlots(slots: NormalizedSlot[]): NormalizedSlot[] {
    const map = new Map<string, NormalizedSlot>();
    for (const slot of slots) {
      const key = slot.startIso ?? "";
      if (!map.has(key)) {
        map.set(key, slot);
      }
    }
    return [...map.values()].sort((a, b) => {
      const aTime = a.startDate?.getTime() ?? 0;
      const bTime = b.startDate?.getTime() ?? 0;
      return aTime - bTime;
    });
  }

  private normalizeForecastSlot(entry: RawForecastEntry): NormalizedSlot {
    const payload = structuredClone(entry) as MutableRecord;
    const startDate = parseTimestamp(payload.start ?? payload.from);
    let endDate = parseTimestamp(payload.end ?? payload.to);
    if (!endDate && startDate) {
      endDate = new Date(startDate.getTime() + SLOT_DURATION_MS);
    }
    if (startDate && endDate && endDate.getTime() <= startDate.getTime()) {
      endDate = new Date(startDate.getTime() + SLOT_DURATION_MS);
    }
    const startIso = startDate ? startDate.toISOString() : null;
    const endIso = endDate ? endDate.toISOString() : null;
    if (startIso) {
      payload.start = startIso;
    }
    if (endIso) {
      payload.end = endIso;
    }
    let timeSlot: TimeSlot | null = null;
    if (startDate && endDate) {
      try {
        timeSlot = TimeSlot.fromDates(startDate, endDate);
      } catch (error) {
        void error;
        timeSlot = null;
      }
    }
    const durationHours = timeSlot ? timeSlot.duration.hours : null;

    return {
      payload,
      startDate,
      endDate,
      startIso,
      endIso,
      durationHours,
      timeSlot,
    };
  }

  private resolvePriceFields(sourcePayload: MutableRecord): {priceValue: unknown; unitValue: unknown} {
    if (this.toNumber(sourcePayload.price) !== null) {
      return {
        priceValue: sourcePayload.price,
        unitValue: sourcePayload.unit ?? sourcePayload.price_unit ?? sourcePayload.value_unit,
      };
    }
    if (this.toNumber(sourcePayload.value) !== null) {
      return {
        priceValue: sourcePayload.value,
        unitValue: sourcePayload.value_unit ?? sourcePayload.price_unit ?? sourcePayload.unit,
      };
    }
    if (this.toNumber(sourcePayload.price_eur_per_kwh) !== null) {
      return {
        priceValue: sourcePayload.price_eur_per_kwh,
        unitValue: "EUR/kWh",
      };
    }
    if (this.toNumber(sourcePayload.price_ct_per_kwh) !== null) {
      return {
        priceValue: sourcePayload.price_ct_per_kwh,
        unitValue: "ct/kWh",
      };
    }
    return {
      priceValue: sourcePayload.price,
      unitValue: sourcePayload.unit ?? sourcePayload.price_unit ?? sourcePayload.value_unit,
    };
  }

  private parseEnergyPrice(value: unknown, unit: unknown): EnergyPrice | null {
    const numeric = this.toNumber(value);
    if (numeric === null) {
      return null;
    }
    const unitStrRaw = typeof unit === "string" ? unit.trim() : "";
    const unitStr = unitStrRaw.toLowerCase();
    if (unitStr.length) {
      const parsed = EnergyPrice.tryFromValue(numeric, unitStr);
      if (parsed) {
        return parsed;
      }
    }
    if (Math.abs(numeric) > 10) {
      return EnergyPrice.fromCentsPerKwh(numeric);
    }
    return EnergyPrice.fromEurPerKwh(numeric);
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    }
    return null;
  }
}
