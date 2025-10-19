import { Duration } from "./duration";
import { Energy } from "./energy";
import { Scalar } from "./scalar";

export class Power {
  private readonly _watts: number;

  private constructor(watts: number) {
    if (!Number.isFinite(watts)) {
      throw new TypeError("Power requires a finite numeric value in watts");
    }
    this._watts = watts;
  }

  static fromWatts(value: number): Power {
    return new Power(value);
  }

  static fromKilowatts(value: number): Power {
    return new Power(value * 1000);
  }

  static zero(): Power {
    return new Power(0);
  }

  get watts(): number {
    return this._watts;
  }

  get kilowatts(): number {
    return this._watts / 1000;
  }

  toJSON(): number {
    return this._watts;
  }

  add(other: Power): Power {
    return new Power(this._watts + other._watts);
  }

  subtract(other: Power): Power {
    return new Power(this._watts - other._watts);
  }

  multiply(factor: number | Scalar): Power {
    const numeric = factor instanceof Scalar ? factor.value : factor;
    return new Power(this._watts * numeric);
  }

  scale(factor: number | Scalar): Power {
    return this.multiply(factor);
  }

  forDuration(duration: Duration): Energy {
    return Energy.fromPowerAndDuration(this, duration);
  }

  clamp(min: Power, max: Power): Power {
    const lower = Math.min(min._watts, max._watts);
    const upper = Math.max(min._watts, max._watts);
    const bounded = Math.min(Math.max(this._watts, lower), upper);
    return new Power(bounded);
  }

  equals(other: Power | null | undefined): boolean {
    return other instanceof Power && Math.abs(this._watts - other._watts) < 1e-9;
  }
}
