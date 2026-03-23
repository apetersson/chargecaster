import { describe, expect, it } from "vitest";

import { Energy, Percentage } from "@chargecaster/domain";
import type { HistoryPoint } from "@chargecaster/domain";
import { BatteryEfficiencyService } from "../src/simulation/battery-efficiency.service";
import type { HistoryRecord, StorageService } from "../src/storage/storage.service";

function toHistoryRecord(payload: HistoryPoint, index: number): HistoryRecord {
  return {
    id: index + 1,
    timestamp: payload.timestamp,
    payload,
  };
}

function createChargePoint(timestamp: string, socPercent: number, batteryChargePowerW: number): HistoryPoint {
  const siteDemandPowerW = 2000;
  return {
    timestamp,
    battery_soc_percent: socPercent,
    price_eur_per_kwh: 0.2,
    price_ct_per_kwh: 20,
    grid_power_w: siteDemandPowerW + Math.abs(batteryChargePowerW),
    solar_power_w: 0,
    solar_forecast_power_w: 0,
    solar_energy_wh: 0,
    home_power_w: siteDemandPowerW,
    ev_charge_power_w: 0,
    site_demand_power_w: siteDemandPowerW,
  };
}

function createDischargePoint(timestamp: string, socPercent: number, batteryDischargePowerW: number): HistoryPoint {
  const siteDemandPowerW = 2000;
  return {
    timestamp,
    battery_soc_percent: socPercent,
    price_eur_per_kwh: 0.2,
    price_ct_per_kwh: 20,
    grid_power_w: siteDemandPowerW - Math.abs(batteryDischargePowerW),
    solar_power_w: 0,
    solar_forecast_power_w: 0,
    solar_energy_wh: 0,
    home_power_w: siteDemandPowerW,
    ev_charge_power_w: 0,
    site_demand_power_w: siteDemandPowerW,
  };
}

describe("BatteryEfficiencyService", () => {
  it("falls back to defaults when recent history is too sparse", () => {
    const storage = {
      listHistoryRangeAsc: () => [
        toHistoryRecord(createChargePoint("2026-03-21T10:00:00.000Z", 50, 1000), 0),
        toHistoryRecord(createChargePoint("2026-03-21T10:05:00.000Z", 50.5, 1000), 1),
      ],
    } as unknown as StorageService;

    const service = new BatteryEfficiencyService(storage);
    const estimate = service.estimateRecentEfficiencies(
      Energy.fromKilowattHours(10),
      new Date("2026-03-21T12:00:00.000Z"),
    );

    expect(estimate.source).toBe("fallback");
    expect(estimate.chargeEfficiency.equals(Percentage.fromRatio(0.95))).toBe(true);
    expect(estimate.dischargeEfficiency.equals(Percentage.fromRatio(0.95))).toBe(true);
    expect(estimate.chargeAverageCRate).toBeCloseTo(0.25, 6);
    expect(estimate.dischargeAverageCRate).toBeCloseTo(0.25, 6);
    expect(estimate.chargeRuns).toBe(0);
    expect(estimate.dischargeRuns).toBe(0);
  });

  it("estimates separate charge and discharge efficiencies from recent history", () => {
    const capacityKwh = 10;
    const chargeEfficiency = 0.93;
    const dischargeEfficiency = 0.968;
    const powerW = 1000;
    const intervalHours = 5 / 60;
    const chargeSocStepPercent = (powerW / 1000) * intervalHours * chargeEfficiency / capacityKwh * 100;
    const dischargeSocStepPercent = (powerW / 1000) * intervalHours / dischargeEfficiency / capacityKwh * 100;
    const points: HistoryPoint[] = [];
    const baseMs = Date.parse("2026-03-21T12:00:00.000Z");
    let index = 0;

    const pushRun = (
      runStartMs: number,
      kind: "charge" | "discharge",
      startSocPercent: number,
      steps = 7,
    ) => {
      for (let step = 0; step <= steps; step += 1) {
        const timestamp = new Date(runStartMs + step * 5 * 60 * 1000).toISOString();
        const socPercent = kind === "charge"
          ? startSocPercent + step * chargeSocStepPercent
          : startSocPercent - step * dischargeSocStepPercent;
        points.push(
          kind === "charge"
            ? createChargePoint(timestamp, socPercent, powerW)
            : createDischargePoint(timestamp, socPercent, powerW),
        );
      }
    };

    for (let day = 0; day < 6; day += 1) {
      const dayStartMs = baseMs - day * 24 * 60 * 60 * 1000;
      pushRun(dayStartMs - 8 * 60 * 60 * 1000, "charge", 20 + index);
      pushRun(dayStartMs - 4 * 60 * 60 * 1000, "discharge", 75 - index);
      index += 1;
    }

    const storage = {
      listHistoryRangeAsc: () => points.map(toHistoryRecord),
    } as unknown as StorageService;

    const service = new BatteryEfficiencyService(storage);
    const estimate = service.estimateRecentEfficiencies(Energy.fromKilowattHours(capacityKwh), new Date(baseMs));

    expect(estimate.source).toBe("estimated");
    expect(estimate.chargeRuns).toBeGreaterThanOrEqual(5);
    expect(estimate.dischargeRuns).toBeGreaterThanOrEqual(5);
    expect(estimate.chargeEfficiency.ratio).toBeCloseTo(chargeEfficiency, 2);
    expect(estimate.dischargeEfficiency.ratio).toBeCloseTo(dischargeEfficiency, 2);
    expect(estimate.chargeAverageCRate).toBeCloseTo(powerW / 1000 / capacityKwh * chargeEfficiency, 3);
    expect(estimate.dischargeAverageCRate).toBeCloseTo(powerW / 1000 / capacityKwh / dischargeEfficiency, 3);
  });
});
