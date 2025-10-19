import { Duration } from "./duration";
import { Power } from "./power";
import { Scalar } from "./scalar";

export class Energy {
  private readonly _wattHours: number;

  private constructor(wattHours: number) {
    if (!Number.isFinite(wattHours)) {
      throw new TypeError("Energy requires a finite numeric value in watt-hours");
    }
    this._wattHours = wattHours;
  }

  static fromWattHours(value: number): Energy {
    return new Energy(value);
  }

  static fromKilowattHours(value: number): Energy {
    return new Energy(value * 1000);
  }

  static fromPowerAndDuration(power: Power, duration: Duration): Energy {
    return new Energy(power.watts * duration.hours);
  }

  static zero(): Energy {
    return new Energy(0);
  }

  get wattHours(): number {
    return this._wattHours;
  }

  get kilowattHours(): number {
    return this._wattHours / 1000;
  }

  toJSON(): number {
    return this._wattHours;
  }

  add(other: Energy): Energy {
    return new Energy(this._wattHours + other._wattHours);
  }

  subtract(other: Energy): Energy {
    return new Energy(this._wattHours - other._wattHours);
  }

  multiply(factor: number | Scalar): Energy {
    const numeric = factor instanceof Scalar ? factor.value : factor;
    return new Energy(this._wattHours * numeric);
  }

  scale(factor: number | Scalar): Energy {
    return this.multiply(factor);
  }

  divideByDuration(duration: Duration): Power {
    if (duration.hours === 0) {
      throw new Error("Cannot derive power from zero duration");
    }
    return Power.fromWatts(this._wattHours / duration.hours);
  }

  per(duration: Duration): Power {
    return this.divideByDuration(duration);
  }

  clamp(min: Energy, max: Energy): Energy {
    const lower = Math.min(min._wattHours, max._wattHours);
    const upper = Math.max(min._wattHours, max._wattHours);
    const bounded = Math.min(Math.max(this._wattHours, lower), upper);
    return new Energy(bounded);
  }
}
