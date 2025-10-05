import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";

import type { ForecastEra, RawForecastEntry, RawSolarEntry, SimulationConfig } from "../simulation/types";
import { normalizePriceSlots } from "../simulation/simulation.service";
import { parseTimestamp } from "../simulation/solar";
import { EnergyPrice, TimeSlot } from "@chargecaster/domain";

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

@Injectable()
export class ForecastAssemblyService {
  private readonly logger = new Logger(ForecastAssemblyService.name);

  buildForecastEras(
    canonicalForecast: RawForecastEntry[],
    evccForecast: RawForecastEntry[],
    marketForecast: RawForecastEntry[],
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

    const marketIndex = this.buildStartIndex(marketForecast);

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

      const baseCost = this.applySlotPrice(entry, slot.payload.price, slot.payload.unit, gridFeeEurPerKwh);
      if (baseCost) {
        const costSource: CostSource = {
          provider: "canonical",
          type: "cost",
          payload: baseCost,
        };
        this.addSource(entry, costSource);
      }

      const marketPayload = marketIndex.get(slot.startIso);
      if (marketPayload) {
        const marketCost = this.applySlotPrice(entry, marketPayload.price, marketPayload.unit, gridFeeEurPerKwh);
        if (marketCost) {
          const awattarSource: CostSource = {
            provider: "awattar",
            type: "cost",
            payload: marketCost,
          };
          this.addSource(entry, awattarSource);
        }
      }

      const solarPayload = this.findSolarPayload(slot.startDate, slot.endDate, solarSlots);
      const solarSource = this.buildSolarSource("evcc", slot, solarPayload);
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
        sources: value.sources.map((source) =>
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
    if (!forecast.length) {
      return null;
    }
    const slots = normalizePriceSlots(forecast);
    if (!slots.length) {
      return null;
    }
    const basePrice = slots[0]?.price;
    if (typeof basePrice !== "number" || Number.isNaN(basePrice)) {
      return null;
    }
    const gridFee = config.price?.grid_fee_eur_per_kwh ?? 0;
    return basePrice + gridFee;
  }

  private addSource(entry: EraEntry, source: CostSource | SolarSource): void {
    const exists = entry.sources.some((item) => item.provider === source.provider && item.type === source.type);
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
    priceValue: unknown,
    unitValue: unknown,
    gridFeeEur: number,
  ): CostSource["payload"] | null {
    const energyPrice = this.parseEnergyPrice(priceValue, unitValue);
    if (!energyPrice) {
      return null;
    }
    const totalPrice = energyPrice.withAdditionalFee(gridFeeEur);
    const payload: CostSource["payload"] = {
      price_ct_per_kwh: energyPrice.ctPerKwh,
      price_eur_per_kwh: energyPrice.eurPerKwh,
      price_with_fee_ct_per_kwh: totalPrice.ctPerKwh,
      price_with_fee_eur_per_kwh: totalPrice.eurPerKwh,
      unit: "ct/kWh",
    };

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

  private buildSolarSource(provider: string, slot: NormalizedSlot, raw: MutableRecord | undefined): SolarSource | null {
    if (!raw) {
      return null;
    }
    let energyWh = this.toNumber(raw.energy_wh);
    if (energyWh === null) {
      const energyKwh = this.toNumber(raw.energy_kwh);
      if (energyKwh !== null) {
        energyWh = energyKwh * 1000;
      }
    }
    if (energyWh === null || energyWh <= 0) {
      return null;
    }
    const durationHours = slot.timeSlot?.duration.hours ?? slot.durationHours ?? null;
    const averagePower = durationHours && durationHours > 0 ? energyWh / durationHours : undefined;
    return averagePower !== undefined
      ? {provider, type: "solar", payload: {energy_wh: energyWh, average_power_w: averagePower}}
      : {provider, type: "solar", payload: {energy_wh: energyWh}};
  }

  private findSolarPayload(startDate: Date | null, endDate: Date | null, slots: NormalizedSlot[]): MutableRecord | undefined {
    if (!startDate) {
      return undefined;
    }
    const startIso = startDate.toISOString();
    const direct = slots.find((slot) => slot.startIso === startIso);
    if (direct) {
      return {...direct.payload};
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
        return {...slot.payload};
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
