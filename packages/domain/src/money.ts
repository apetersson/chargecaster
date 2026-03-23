import { Scalar } from "./scalar";

export class Money {
  private readonly eurValue: number;

  private constructor(eur: number) {
    if (!Number.isFinite(eur)) {
      throw new TypeError("Money requires a finite numeric value in EUR");
    }
    this.eurValue = eur;
  }

  static fromEur(value: number): Money {
    return new Money(value);
  }

  static zero(): Money {
    return new Money(0);
  }

  get eur(): number {
    return this.eurValue;
  }

  toJSON(): number {
    return this.eurValue;
  }

  add(other: Money): Money {
    return new Money(this.eurValue + other.eurValue);
  }

  subtract(other: Money): Money {
    return new Money(this.eurValue - other.eurValue);
  }

  multiply(factor: number | Scalar): Money {
    const numeric = factor instanceof Scalar ? factor.value : factor;
    return new Money(this.eurValue * numeric);
  }

  negate(): Money {
    return new Money(-this.eurValue);
  }

  abs(): Money {
    return new Money(Math.abs(this.eurValue));
  }

  min(other: Money): Money {
    return this.eurValue <= other.eurValue ? this : other;
  }

  max(other: Money): Money {
    return this.eurValue >= other.eurValue ? this : other;
  }

  equals(other: Money | null | undefined): boolean {
    return other instanceof Money && Math.abs(this.eurValue - other.eurValue) < 1e-9;
  }
}
