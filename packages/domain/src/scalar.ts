export class Scalar {
  protected readonly numericValue: number;

  protected constructor(value: number) {
    if (!Number.isFinite(value)) {
      throw new TypeError("Scalar requires a finite numeric value");
    }
    this.numericValue = value;
  }

  static of(value: number): Scalar {
    return new Scalar(value);
  }

  static zero(): Scalar {
    return new Scalar(0);
  }

  static one(): Scalar {
    return new Scalar(1);
  }

  static from(value: number | Scalar): Scalar {
    return value instanceof Scalar ? value : Scalar.of(value);
  }

  get value(): number {
    return this.numericValue;
  }

  valueOf(): number {
    return this.numericValue;
  }

  toJSON(): number {
    return this.numericValue;
  }

  times(factor: number | Scalar): Scalar {
    const numeric = Scalar.resolve(factor);
    return new Scalar(this.numericValue * numeric);
  }

  divide(divisor: number | Scalar): Scalar {
    const numeric = Scalar.resolve(divisor);
    if (numeric === 0) {
      throw new RangeError("Cannot divide by zero");
    }
    return new Scalar(this.numericValue / numeric);
  }

  clamp(min: number | Scalar, max: number | Scalar): Scalar {
    const minNumeric = Scalar.resolve(min);
    const maxNumeric = Scalar.resolve(max);
    if (minNumeric > maxNumeric) {
      throw new RangeError("Clamp minimum cannot exceed maximum");
    }
    return new Scalar(Math.min(Math.max(this.numericValue, minNumeric), maxNumeric));
  }

  equals(other: unknown): boolean {
    return other instanceof Scalar && Math.abs(this.numericValue - other.numericValue) < 1e-9;
  }

  protected static resolve(input: number | Scalar): number {
    return input instanceof Scalar ? input.numericValue : input;
  }
}
