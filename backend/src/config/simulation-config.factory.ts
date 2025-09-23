import { Injectable } from "@nestjs/common";

import type { SimulationConfig } from "../simulation/types";
import type { ConfigDocument } from "./schemas";

@Injectable()
export class SimulationConfigFactory {
  create(config: ConfigDocument): SimulationConfig {
    const battery = config.battery ?? {};
    const price = config.price ?? {};
    const logic = config.logic ?? {};
    const solar = config.solar ?? {};

    const capacity = this.numberOrZero(battery.capacity_kwh);
    const chargePower = this.numberOrZero(battery.max_charge_power_w);
    const floorSoc = this.numberOrUndefined(battery.auto_mode_floor_soc);

    const gridFee = this.numberOrZero(price.grid_fee_eur_per_kwh);
    const feedInTariff = this.numberOrUndefined(price.feed_in_tariff_eur_per_kwh);

    const intervalSeconds = this.numberOrNull(logic.interval_seconds, 300);
    const minHoldMinutes = this.numberOrUndefined(logic.min_hold_minutes);
    const houseLoad = this.numberOrUndefined(logic.house_load_w);
    const allowBatteryExport = logic.allow_battery_export ?? true;

    const directUseRatio = this.normalizeRatio(solar.direct_use_ratio);
    const maxSolarChargePower = this.numberOrUndefined(battery.max_charge_power_solar_w, 0);

    return {
      battery: {
        capacity_kwh: capacity,
        max_charge_power_w: chargePower,
        auto_mode_floor_soc: floorSoc,
        max_charge_power_solar_w: maxSolarChargePower,
      },
      price: {
        grid_fee_eur_per_kwh: gridFee,
        feed_in_tariff_eur_per_kwh: feedInTariff,
      },
      logic: {
        interval_seconds: intervalSeconds ?? undefined,
        min_hold_minutes: minHoldMinutes,
        house_load_w: houseLoad,
        allow_battery_export: allowBatteryExport,
      },
      solar:
        directUseRatio === null
          ? undefined
          : {
            direct_use_ratio: directUseRatio,
          },
    };
  }

  private numberOrZero(value: unknown): number {
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
  }

  private numberOrUndefined(value: unknown, min = -Infinity): number | undefined {
    const numeric = typeof value === "number" && Number.isFinite(value) ? value : Number(value);
    if (!Number.isFinite(numeric)) {
      return undefined;
    }
    return numeric >= min ? numeric : undefined;
  }

  private numberOrNull(value: unknown, fallback: number | null = null): number | null {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string") {
      const numeric = Number(value);
      if (Number.isFinite(numeric) && numeric > 0) {
        return numeric;
      }
    }
    return fallback;
  }

  private normalizeRatio(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    const clamped = Math.min(Math.max(value, 0), 1);
    return clamped;
  }

  getIntervalSeconds(config: SimulationConfig): number | null {
    const value = config.logic?.interval_seconds;
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    return null;
  }
}
