import { Duration } from "./duration";
import { Percentage } from "./percentage";

export class TimeSlot {
  private readonly _start: Date;
  private readonly _end: Date;

  private constructor(start: Date, end: Date) {
    if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
      throw new TypeError("Invalid start date for time slot");
    }
    if (!(end instanceof Date) || Number.isNaN(end.getTime())) {
      throw new TypeError("Invalid end date for time slot");
    }
    if (end.getTime() <= start.getTime()) {
      throw new RangeError("Time slot end must be after start");
    }
    this._start = new Date(start.getTime());
    this._end = new Date(end.getTime());
  }

  static fromDates(start: Date, end: Date): TimeSlot {
    return new TimeSlot(start, end);
  }

  static fromTimestamps(start: number, end: number): TimeSlot {
    return new TimeSlot(new Date(start), new Date(end));
  }

  static fromStartAndDuration(start: Date, duration: Duration): TimeSlot {
    return new TimeSlot(start, new Date(start.getTime() + duration.milliseconds));
  }

  get start(): Date {
    return new Date(this._start.getTime());
  }

  get end(): Date {
    return new Date(this._end.getTime());
  }

  get duration(): Duration {
    return Duration.between(this._start, this._end);
  }

  midpoint(): Date {
    const durationMs = this.duration.milliseconds;
    return new Date(this._start.getTime() + durationMs / 2);
  }

  overlapDuration(other: TimeSlot): Duration {
    const start = Math.max(this._start.getTime(), other._start.getTime());
    const end = Math.min(this._end.getTime(), other._end.getTime());
    if (end <= start) {
      return Duration.zero();
    }
    return Duration.fromMilliseconds(end - start);
  }

  overlapPercentage(other: TimeSlot): Percentage {
    const overlap = this.overlapDuration(other);
    const baseMs = this.duration.milliseconds;
    if (baseMs === 0) {
      return Percentage.zero();
    }
    return Percentage.fromRatio(overlap.milliseconds / baseMs);
  }

  toJSON(): { start: string; end: string } {
    return {start: this._start.toISOString(), end: this._end.toISOString()};
  }
}
