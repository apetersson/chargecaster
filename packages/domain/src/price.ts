export class EnergyPrice {
  private readonly eurPerKwhValue: number;

  private constructor(eurPerKwh: number) {
    if (!Number.isFinite(eurPerKwh)) {
      throw new TypeError("EnergyPrice requires a finite numeric value expressed in EUR per kWh");
    }
    this.eurPerKwhValue = eurPerKwh;
  }

  static fromEurPerKwh(value: number): EnergyPrice {
    return new EnergyPrice(value);
  }

  static fromCentsPerKwh(value: number): EnergyPrice {
    return new EnergyPrice(value / 100);
  }

  static tryFromValue(value: unknown, unit: unknown): EnergyPrice | null {
    if (value == null) {
      return null;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
      return null;
    }
    const unitStr = typeof unit === "string" ? unit.trim().toLowerCase() : "";
    if (!unitStr || unitStr === "eur/kwh" || unitStr === "€/kwh") {
      return EnergyPrice.fromEurPerKwh(numeric);
    }
    if (unitStr === "ct/kwh" || unitStr === "ct/wh" || unitStr === "cent/kwh") {
      return EnergyPrice.fromCentsPerKwh(numeric);
    }
    if (unitStr === "eur/mwh" || unitStr === "€/mwh") {
      return EnergyPrice.fromEurPerKwh(numeric / 1000);
    }
    if (unitStr === "ct/mwh") {
      return EnergyPrice.fromEurPerKwh(numeric / 100_000);
    }
    return EnergyPrice.fromEurPerKwh(numeric);
  }

  get eurPerKwh(): number {
    return this.eurPerKwhValue;
  }

  get ctPerKwh(): number {
    return this.eurPerKwhValue * 100;
  }

  valueOf(): number {
    return this.eurPerKwhValue;
  }

  toJSON(): number {
    return this.eurPerKwhValue;
  }

  withAdditionalFee(eurPerKwh: number): EnergyPrice {
    return new EnergyPrice(this.eurPerKwhValue + eurPerKwh);
  }
}
