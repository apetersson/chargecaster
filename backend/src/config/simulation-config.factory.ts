import { Injectable } from "@nestjs/common";

import type { SimulationConfig } from "@chargecaster/domain";
import {
  resolveConfiguredStaticFeedInTariffEurPerKwh,
  resolveConfiguredStaticGridFeeEurPerKwh,
  type ConfigDocument,
} from "./schemas";

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
    const logic = config.logic ?? {};

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

    const gridFee = resolveConfiguredStaticGridFeeEurPerKwh(config) ?? 0;
    const feedInTariffRaw = resolveConfiguredStaticFeedInTariffEurPerKwh(config);
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
    const allowBatteryExport = logic.allow_battery_export ?? true;
    const maxSolarChargePowerRaw = coerceNumber(battery.max_charge_power_solar_w);
    const maxSolarChargePower =
      maxSolarChargePowerRaw != null && maxSolarChargePowerRaw >= 0
        ? maxSolarChargePowerRaw
        : undefined;

    return {
      battery: {
        capacity_kwh: capacity,
        chemistry: battery.chemistry ?? undefined,
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
        allow_battery_export: allowBatteryExport,
        optimizer_modes: logic.optimizer_modes ?? undefined,
      },
    };
  }

  getIntervalSeconds(config: SimulationConfig): number | null {
    const value = config.logic.interval_seconds;
    return value && value > 0 ? value : null;
  }
}
