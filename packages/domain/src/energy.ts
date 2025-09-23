import { Duration } from "./duration.js";
import { Power } from "./power.js";

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

  divideByDuration(duration: Duration): Power {
    if (duration.hours === 0) {
      throw new Error("Cannot derive power from zero duration");
    }
    return Power.fromWatts(this._wattHours / duration.hours);
  }
}
