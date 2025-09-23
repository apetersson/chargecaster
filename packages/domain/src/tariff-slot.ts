import { Duration } from "./duration.js";
import { EnergyPrice } from "./price.js";
import { TimeSlot } from "./time-slot.js";

export class TariffSlot {
  private readonly slot: TimeSlot;
  private readonly energyPriceValue: EnergyPrice;
  private readonly identifier?: string;

  private constructor(slot: TimeSlot, price: EnergyPrice, eraId?: string) {
    this.slot = slot;
    this.energyPriceValue = price;
    this.identifier = eraId;
  }

  static fromDates(start: Date, end: Date, price: EnergyPrice, eraId?: string): TariffSlot {
    return new TariffSlot(TimeSlot.fromDates(start, end), price, eraId);
  }

  static fromTimeSlot(slot: TimeSlot, price: EnergyPrice, eraId?: string): TariffSlot {
    return new TariffSlot(slot, price, eraId);
  }

  get start(): Date {
    return this.slot.start;
  }

  get end(): Date {
    return this.slot.end;
  }

  get duration(): Duration {
    return this.slot.duration;
  }

  get durationHours(): number {
    return this.slot.duration.hours;
  }

  get price(): number {
    return this.energyPriceValue.eurPerKwh;
  }

  get energyPrice(): EnergyPrice {
    return this.energyPriceValue;
  }

  get eraId(): string | undefined {
    return this.identifier;
  }

  withEraId(eraId: string | undefined): TariffSlot {
    return new TariffSlot(this.slot, this.energyPriceValue, eraId);
  }

  withAddedFee(eurPerKwh: number): TariffSlot {
    return new TariffSlot(this.slot, this.energyPriceValue.withAdditionalFee(eurPerKwh), this.identifier);
  }

  midpoint(): Date {
    const startMs = this.start.getTime();
    const endMs = this.end.getTime();
    return new Date(startMs + (endMs - startMs) / 2);
  }

  toJSON(): {
    start: string;
    end: string;
    duration_hours: number;
    price_eur_per_kwh: number;
    era_id?: string;
  } {
    return {
      start: this.start.toISOString(),
      end: this.end.toISOString(),
      duration_hours: this.durationHours,
      price_eur_per_kwh: this.price,
      era_id: this.identifier,
    };
  }
}
