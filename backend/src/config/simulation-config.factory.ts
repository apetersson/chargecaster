import { Injectable } from "@nestjs/common";

import type { SimulationConfig } from "@chargecaster/domain";
import type { ConfigDocument } from "./schemas";

function coerceNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

@Injectable()
export class SimulationConfigFactory {
  create(config: ConfigDocument): SimulationConfig {
    const battery = config.battery ?? {};
    const price = config.price ?? {};
    const logic = config.logic ?? {};
    const solar = config.solar ?? {};

    const capacity = coerceNumber(battery.capacity_kwh) ?? 0;
    const maxChargePower = coerceNumber(battery.max_charge_power_w) ?? 0;
    const floorSoc = coerceNumber(battery.auto_mode_floor_soc);
    const maxDischargePower =
      coerceNumber(battery.max_discharge_power_w) ?? undefined;
    const maxDischargePowerValid =
      maxDischargePower != null && maxDischargePower >= 0 ? maxDischargePower : undefined;
    const maxChargeSocRaw = coerceNumber(battery.max_charge_soc_percent);
    const maxChargeSoc =
      maxChargeSocRaw == null
        ? undefined
        : Math.min(Math.max(maxChargeSocRaw, 0), 100);

    const gridFee = coerceNumber(price.grid_fee_eur_per_kwh) ?? 0;
    const feedInTariffRaw = coerceNumber(price.feed_in_tariff_eur_per_kwh);
    const feedInTariff =
      feedInTariffRaw != null && feedInTariffRaw >= 0 ? feedInTariffRaw : null;

    const intervalSecondsRaw = coerceNumber(logic.interval_seconds);
    const intervalSeconds =
      intervalSecondsRaw && intervalSecondsRaw > 0 ? intervalSecondsRaw : 300;
    const minHoldMinutesRaw = coerceNumber(logic.min_hold_minutes);
    const minHoldMinutes =
      minHoldMinutesRaw != null && minHoldMinutesRaw >= 0
        ? minHoldMinutesRaw
        : undefined;
    const houseLoadRaw = coerceNumber(logic.house_load_w);
    const houseLoad =
      houseLoadRaw != null && houseLoadRaw >= 0
        ? houseLoadRaw
        : undefined;
    const allowBatteryExport = logic.allow_battery_export ?? true;

    const directUseRatioRaw = coerceNumber(solar.direct_use_ratio);
    const directUseRatio =
      directUseRatioRaw == null
        ? null
        : Math.min(Math.max(directUseRatioRaw, 0), 1);
    const maxSolarChargePowerRaw = coerceNumber(battery.max_charge_power_solar_w);
    const maxSolarChargePower =
      maxSolarChargePowerRaw != null && maxSolarChargePowerRaw >= 0
        ? maxSolarChargePowerRaw
        : undefined;

    return {
      battery: {
        capacity_kwh: capacity,
        max_charge_power_w: maxChargePower,
        auto_mode_floor_soc: floorSoc ?? null,
        max_charge_power_solar_w: maxSolarChargePower ?? null,
        max_discharge_power_w: maxDischargePowerValid ?? null,
        max_charge_soc_percent: maxChargeSoc ?? null,
      },
      price: {
        grid_fee_eur_per_kwh: gridFee,
        feed_in_tariff_eur_per_kwh: feedInTariff,
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
