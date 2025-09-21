import { useMemo } from "react";

import type { ForecastEra, OracleEntry } from "../types";
import { formatDate, formatNumber, formatPercent, timeFormatter } from "../utils/format";

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

const toNumeric = (value: unknown): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.length > 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return null;
};

const convertToCents = (value: number | null, unit: unknown): number | null => {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const unitStr = typeof unit === "string" ? unit.trim().toLowerCase() : "";
  if (!unitStr) {
    return value * 100;
  }
  if (unitStr.includes("ct") && unitStr.includes("/wh")) {
    return value * 1000;
  }
  if (unitStr.includes("ct") && unitStr.includes("kwh")) {
    return value;
  }
  if ((unitStr.includes("eur") || unitStr.includes("€/")) && unitStr.includes("mwh")) {
    return value / 10;
  }
  if ((unitStr.includes("eur") || unitStr.includes("€/")) && unitStr.includes("wh")) {
    return value * 100000;
  }
  if ((unitStr.includes("eur") || unitStr.includes("€/")) && unitStr.includes("kwh")) {
    return value * 100;
  }
  if (unitStr.includes("ct")) {
    return value;
  }
  if (unitStr.includes("eur")) {
    return value * 100;
  }
  return value * 100;
};

const resolveCost = (era: ForecastEra, provider: string) => {
  const match = era.sources.find(
    (source) =>
      source &&
      source.type === "cost" &&
      typeof source.provider === "string" &&
      source.provider.toLowerCase() === provider,
  );
  if (!match) {
    return null;
  }
  const payload = match.payload ?? {};
  const existingCents = toNumeric((payload as { price_ct_per_kwh?: unknown }).price_ct_per_kwh);
  if (existingCents !== null) {
    return { priceCt: existingCents };
  }
  const raw =
    toNumeric((payload as { price?: unknown }).price) ??
    toNumeric((payload as { value?: unknown }).value);
  const unit =
    (payload as { unit?: unknown }).unit ??
    (payload as { price_unit?: unknown }).price_unit ??
    (payload as { value_unit?: unknown }).value_unit;
  const priceCt = convertToCents(raw, unit);
  return { priceCt };
};

const resolveSolar = (era: ForecastEra) => {
  const match = era.sources.find((source) => source.type === "solar");
  if (!match) {
    return { energyKwh: null, averageW: null };
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
    const duration =
      typeof era.duration_hours === "number" && Number.isFinite(era.duration_hours)
        ? era.duration_hours
        : null;
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
  return { energyKwh, averageW };
};

const TrajectoryTable = ({ forecast, oracleEntries }: TrajectoryTableProps) => {
  const now = Date.now();
  const oracleMap = useMemo(() => {
    const map = new Map<string, OracleEntry>();
    oracleEntries.forEach((entry) => {
      if (entry && typeof entry.era_id === "string") {
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
              <th>Target SOC %</th>
              <th>Grid Power (W)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((era) => {
              const marketCost = resolveCost(era, "awattar");
              const solar = resolveSolar(era);
              const oracle = oracleMap.get(era.era_id);
              const solarLabel =
                solar.averageW !== null
                  ? formatNumber(solar.averageW, " W")
                  : solar.energyKwh !== null
                    ? formatNumber(solar.energyKwh, " kWh")
                    : "n/a";
              const gridPower = oracle ? formatNumber(oracle.grid_energy_w, " W") : "n/a";
              return (
                <tr key={era.era_id}>
                  <td>{formatDate(era.start)}</td>
                  <td>{era.end ? timeFormatter.format(new Date(era.end)) : "n/a"}</td>
                  <td>{marketCost && marketCost.priceCt !== null ? formatNumber(marketCost.priceCt, " ct/kWh") : "n/a"}</td>
                  <td>{solarLabel}</td>
                  <td>{formatPercent(oracle?.target_soc_percent ?? null)}</td>
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
