import { useMemo } from "react";

import type { ForecastEra, OracleEntry } from "../types";
import { formatDate, formatNumber, formatPercent, timeFormatter } from "../utils/format";
import { toNumeric } from "../utils/number";
import { EnergyPrice, TimeSlot } from "@batteryctl/domain";

type TrajectoryTableProps = {
  forecast: ForecastEra[];
  oracleEntries: OracleEntry[];
};

const parseTime = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : null;
};

const parseEnergyPrice = (value: number | null, unit: unknown): EnergyPrice | null => {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const unitStrRaw = typeof unit === "string" ? unit.trim() : "";
  const unitStr = unitStrRaw.toLowerCase();
  if (unitStr.length) {
    const parsed = EnergyPrice.tryFromValue(value, unitStr);
    if (parsed) {
      return parsed;
    }
  }
  if (Math.abs(value) > 10) {
    return EnergyPrice.fromCentsPerKwh(value);
  }
  return EnergyPrice.fromEurPerKwh(value);
};

const convertToCents = (value: number | null, unit: unknown): number | null => {
  const price = parseEnergyPrice(value, unit);
  return price ? price.ctPerKwh : null;
};

const resolveCost = (era: ForecastEra, provider: string) => {
  const match = era.sources.find(
    (source) =>
      source &&
      source.type === "cost" &&
      source.provider.toLowerCase() === provider,
  );
  if (!match) {
    return null;
  }
  const payload = match.payload ?? {};
  const centsWithFee = toNumeric((payload as { price_with_fee_ct_per_kwh?: unknown }).price_with_fee_ct_per_kwh);
  if (centsWithFee !== null) {
    return {priceCt: centsWithFee};
  }
  const existingCents = toNumeric((payload as { price_ct_per_kwh?: unknown }).price_ct_per_kwh);
  if (existingCents !== null) {
    return {priceCt: existingCents};
  }
  const raw =
    toNumeric((payload as { price?: unknown }).price) ??
    toNumeric((payload as { value?: unknown }).value);
  const unit =
    (payload as { unit?: unknown }).unit ??
    (payload as { price_unit?: unknown }).price_unit ??
    (payload as { value_unit?: unknown }).value_unit;
  const priceCt = convertToCents(raw, unit);
  return {priceCt};
};

const resolveSolar = (era: ForecastEra, slot: TimeSlot | null) => {
  const match = era.sources.find((source) => source.type === "solar");
  if (!match) {
    return {energyKwh: null, averageW: null};
  }
  const payload = match.payload ?? {};
  let energyKwh = toNumeric((payload as { energy_kwh?: unknown }).energy_kwh);
  if (energyKwh === null) {
    const energyWh = toNumeric((payload as { energy_wh?: unknown }).energy_wh);
    if (energyWh !== null) {
      energyKwh = energyWh / 1000;
    }
  }
  let averageW: number | null = null;
  if (energyKwh !== null) {
    const duration = slot ? slot.duration.hours :
      (typeof era.duration_hours === "number" && Number.isFinite(era.duration_hours)
        ? era.duration_hours
        : null);
    if (duration && duration > 0) {
      averageW = (energyKwh / duration) * 1000;
    }
  }
  if (averageW === null) {
    averageW =
      toNumeric((payload as { power_w?: unknown }).power_w) ??
      toNumeric((payload as { value?: unknown }).value) ??
      toNumeric((payload as { power?: unknown }).power);
  }
  return {energyKwh, averageW};
};

const TrajectoryTable = ({forecast, oracleEntries}: TrajectoryTableProps) => {
  const now = Date.now();
  const oracleMap = useMemo(() => {
    const map = new Map<string, OracleEntry>();
    oracleEntries.forEach((entry) => {
      if (entry) {
        map.set(entry.era_id, entry);
      }
    });
    return map;
  }, [oracleEntries]);

  const rows = [...forecast]
    .filter((era) => {
      const startTime = parseTime(era.start);
      const endTime = parseTime(era.end);
      if (endTime !== null && endTime <= now) {
        return false;
      }
      if (startTime === null) {
        return false;
      }
      return startTime > now;
    })
    .sort((a, b) => {
      const startA = parseTime(a.start) ?? 0;
      const startB = parseTime(b.start) ?? 0;
      return startA - startB;
    });

  if (!rows.length) {
    return (
      <section className="card">
        <p>No forecast data available.</p>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Forecast Horizon</h2>
      <div className="table-wrapper">
        <table>
          <thead>
          <tr>
            <th>Start</th>
            <th>End</th>
            <th>Market Price</th>
            <th>Solar (W)</th>
            <th>End SOC %</th>
            <th>Grid Power (W)</th>
          </tr>
          </thead>
          <tbody>
          {rows.map((era) => {
            let slot: TimeSlot | null = null;
            if (era.start && era.end) {
              try {
                slot = TimeSlot.fromDates(new Date(era.start), new Date(era.end));
              } catch (error) {
                void error;
                slot = null;
              }
            }
            const marketCost = resolveCost(era, "awattar");
            const solar = resolveSolar(era, slot);
            const oracle = oracleMap.get(era.era_id);
            const solarLabel =
              solar.averageW !== null
                ? formatNumber(solar.averageW, " W")
                : solar.energyKwh !== null
                  ? formatNumber(solar.energyKwh, " kWh")
                  : "n/a";
            const strategy = oracle?.strategy ?? "auto";
            const endSocValue = formatPercent(oracle?.end_soc_percent ?? oracle?.target_soc_percent ?? null);
            const targetLabel = oracle ? `${endSocValue} (${strategy.toUpperCase()})` : "n/a";
            const gridEnergyWh = oracle?.grid_energy_w;
            let gridPower = "n/a";
            if (typeof gridEnergyWh === "number" && Number.isFinite(gridEnergyWh)) {
              const durationHours = slot ? slot.duration.hours :
                (typeof era.duration_hours === "number" && Number.isFinite(era.duration_hours)
                  ? era.duration_hours
                  : (() => {
                    const start = era.start ? new Date(era.start).getTime() : NaN;
                    const end = era.end ? new Date(era.end).getTime() : NaN;
                    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
                      return (end - start) / 3_600_000;
                    }
                    return null;
                  })());
              if (durationHours && durationHours > 0) {
                const powerW = gridEnergyWh / durationHours;
                if (Number.isFinite(powerW)) {
                  gridPower = formatNumber(powerW, " W");
                }
              }
            }
            return (
              <tr key={era.era_id}>
                <td>{formatDate(era.start)}</td>
                <td>{era.end ? timeFormatter.format(new Date(era.end)) : "n/a"}</td>
                <td>{marketCost && marketCost.priceCt !== null ? formatNumber(marketCost.priceCt, " ct/kWh") : "n/a"}</td>
                <td>{solarLabel}</td>
                <td>{targetLabel}</td>
                <td>{gridPower}</td>
              </tr>
            );
          })}
          </tbody>
        </table>
      </div>
    </section>
  );
};

export default TrajectoryTable;
