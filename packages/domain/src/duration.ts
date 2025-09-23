export class Duration {
  private readonly _milliseconds: number;

  private constructor(milliseconds: number) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new TypeError("Duration requires a non-negative finite value in milliseconds");
    }
    this._milliseconds = milliseconds;
  }

  static fromMilliseconds(value: number): Duration {
    return new Duration(value);
  }

  static fromSeconds(value: number): Duration {
    return new Duration(value * 1000);
  }

  static fromMinutes(value: number): Duration {
    return new Duration(value * 60_000);
  }

  static fromHours(value: number): Duration {
    return new Duration(value * 3_600_000);
  }

  static between(start: Date, end: Date): Duration {
    return new Duration(Math.max(0, end.getTime() - start.getTime()));
  }

  static zero(): Duration {
    return new Duration(0);
  }

  get milliseconds(): number {
    return this._milliseconds;
  }

  get seconds(): number {
    return this._milliseconds / 1000;
  }

  get minutes(): number {
    return this._milliseconds / 60_000;
  }

  get hours(): number {
    return this._milliseconds / 3_600_000;
  }

  toJSON(): number {
    return this._milliseconds;
  }

  add(other: Duration): Duration {
    return new Duration(this._milliseconds + other._milliseconds);
  }

  subtract(other: Duration): Duration {
    const result = this._milliseconds - other._milliseconds;
    return new Duration(result >= 0 ? result : 0);
  }
}
