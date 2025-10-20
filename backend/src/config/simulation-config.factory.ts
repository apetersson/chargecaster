import { Injectable } from "@nestjs/common";

import type { SimulationConfig } from "@chargecaster/domain";
import type { ConfigDocument } from "./schemas";

@Injectable()
export class SimulationConfigFactory {
  create(config: ConfigDocument): SimulationConfig {
    const battery = config.battery ?? {};
    const price = config.price ?? {};
    const logic = config.logic ?? {};
    const solar = config.solar ?? {};

    const capacity = battery.capacity_kwh ?? 0;
    const maxChargePower = battery.max_charge_power_w ?? 0;
    const floorSoc = battery.auto_mode_floor_soc;
    const maxDischargePower =
      battery.max_discharge_power_w != null && battery.max_discharge_power_w >= 0
        ? battery.max_discharge_power_w
        : undefined;
    const maxChargeSocRaw = battery.max_charge_soc_percent;
    const maxChargeSoc =
      maxChargeSocRaw == null
        ? undefined
        : Math.min(Math.max(maxChargeSocRaw, 0), 100);

    const gridFee = price.grid_fee_eur_per_kwh ?? 0;
    const feedInTariff = price.feed_in_tariff_eur_per_kwh;

    const intervalSecondsRaw = logic.interval_seconds;
    const intervalSeconds =
      intervalSecondsRaw && intervalSecondsRaw > 0 ? intervalSecondsRaw : 300;
    const minHoldMinutes =
      logic.min_hold_minutes != null && logic.min_hold_minutes >= 0
        ? logic.min_hold_minutes
        : undefined;
    const houseLoad =
      logic.house_load_w != null && logic.house_load_w >= 0
        ? logic.house_load_w
        : undefined;
    const allowBatteryExport = logic.allow_battery_export ?? true;

    const directUseRatioRaw = solar.direct_use_ratio;
    const directUseRatio =
      directUseRatioRaw == null
        ? null
        : Math.min(Math.max(directUseRatioRaw, 0), 1);
    const maxSolarChargePower =
      battery.max_charge_power_solar_w != null && battery.max_charge_power_solar_w >= 0
        ? battery.max_charge_power_solar_w
        : undefined;

    return {
      battery: {
        capacity_kwh: capacity,
        max_charge_power_w: maxChargePower,
        auto_mode_floor_soc: floorSoc ?? null,
        max_charge_power_solar_w: maxSolarChargePower ?? null,
        max_discharge_power_w: maxDischargePower ?? null,
        max_charge_soc_percent: maxChargeSoc ?? null,
      },
      price: {
        grid_fee_eur_per_kwh: gridFee,
        feed_in_tariff_eur_per_kwh: feedInTariff ?? null,
      },
      logic: {
        interval_seconds: intervalSeconds,
        min_hold_minutes: minHoldMinutes ?? null,
        house_load_w: houseLoad ?? null,
        allow_battery_export: allowBatteryExport,
      },
      solar:
        directUseRatio == null
          ? undefined
          : {
            direct_use_ratio: directUseRatio,
          },
    };
  }

  getIntervalSeconds(config: SimulationConfig): number | null {
    const value = config.logic.interval_seconds;
    return value && value > 0 ? value : null;
  }
}
