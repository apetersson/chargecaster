import { Scalar } from "./scalar";

export class Percentage extends Scalar {
  private constructor(ratio: number) {
    super(Percentage.normalize(ratio));
  }

  static fromPercent(value: number): Percentage {
    return new Percentage(value / 100);
  }

  static fromRatio(value: number): Percentage {
    return new Percentage(value);
  }

  static zero(): Percentage {
    return new Percentage(0);
  }

  static full(): Percentage {
    return new Percentage(1);
  }

  get ratio(): number {
    return this.value;
  }

  get percent(): number {
    return this.value * 100;
  }

  invert(): Percentage {
    return new Percentage(1 - this.value);
  }

  protected static override resolve(input: number | Scalar): number {
    return input instanceof Percentage ? input.ratio : super.resolve(input);
  }

  private static normalize(value: number): number {
    if (!Number.isFinite(value)) {
      throw new TypeError("Percentage requires a finite numeric value");
    }
    if (value < 0) {
      return 0;
    }
    if (value > 1) {
      return 1;
    }
    return value;
  }
}
