import { useMemo } from "react";

import type { ForecastEra, ForecastSourcePayload, OracleEntry, SnapshotSummary } from "../types";
import { dateTimeNoSecondsFormatter, formatNumber, formatPercent, timeFormatter } from "../utils/format";
import { TimeSlot } from "@chargecaster/domain";

type TrajectoryTableProps = {
  forecast: ForecastEra[];
  oracleEntries: OracleEntry[];
  summary?: SnapshotSummary | null;
};

const parseTime = (value: string | null | undefined): number | null => {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  const time = parsed.getTime();
  return Number.isFinite(time) ? time : null;
};

const buildOracleLookup = (entries: OracleEntry[]): Map<string, OracleEntry> => {
  const map = new Map<string, OracleEntry>();
  entries.forEach((entry) => {
    if (!entry || typeof entry.era_id !== "string" || entry.era_id.length === 0) {
      return;
    }
    map.set(entry.era_id, entry);
    const timestamp = parseTime(entry.era_id);
    if (timestamp !== null) {
      map.set(String(timestamp), entry);
    }
  });
  return map;
};

const findOracleForEra = (
  era: ForecastEra,
  lookup: Map<string, OracleEntry>,
): OracleEntry | undefined => {
  if (typeof era.era_id === "string" && era.era_id.length > 0) {
    const direct = lookup.get(era.era_id);
    if (direct) {
      return direct;
    }
    const normalized = parseTime(era.era_id);
    if (normalized !== null) {
      const normalizedMatch = lookup.get(String(normalized));
      if (normalizedMatch) {
        return normalizedMatch;
      }
    }
  }

  const startKey = parseTime(era.start);
  if (startKey !== null) {
    const startMatch = lookup.get(String(startKey));
    if (startMatch) {
      return startMatch;
    }
  }

  return undefined;
};

const resolveCost = (era: ForecastEra, provider: string) => {
  const match = era.sources.find(
    (source): source is Extract<ForecastSourcePayload, { type: "cost" }> =>
      source.type === "cost" && source.provider.toLowerCase() === provider,
  );
  if (!match) {
    return null;
  }
  const payload = match.payload;
  const priceCt = payload.price_with_fee_ct_per_kwh ?? payload.price_ct_per_kwh;
  return {priceCt};
};

const resolveSolar = (era: ForecastEra, slot: TimeSlot | null) => {
  const match = era.sources.find(
    (source): source is Extract<ForecastSourcePayload, { type: "solar" }> => source.type === "solar",
  );
  if (!match) {
    return {energyKwh: null, averageW: null};
  }
  const energyWh = match.payload.energy_wh;
  const energyKwh = energyWh / 1000;
  const durationHours = slot ? slot.duration.hours :
    (typeof era.duration_hours === "number" && Number.isFinite(era.duration_hours)
      ? era.duration_hours
      : null);
  const averageW = match.payload.average_power_w ?? (
    durationHours && durationHours > 0 ? energyWh / durationHours : null
  );
  return {energyKwh, averageW};
};

const TrajectoryTable = ({forecast, oracleEntries, summary}: TrajectoryTableProps) => {
  const now = Date.now();
  const oracleLookup = useMemo(() => buildOracleLookup(oracleEntries), [oracleEntries]);

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
      return true;
    })
    .sort((a, b) => {
      const startA = parseTime(a.start) ?? 0;
      const startB = parseTime(b.start) ?? 0;
      return startA - startB;
    });

  if (!rows.length) return (<section className="card"><p>No forecast data available.</p></section>);

  return (
    <section className="card">
      <h2>Forecast Horizon</h2>
      <div className="table-wrapper">
        <table className="forecast-table">
          <colgroup>
            <col className="col-time" />
            <col className="col-price" />
            <col className="col-solar" />
            <col className="col-power" />
            <col className="col-soc" />
            <col className="col-power" />
          </colgroup>
          <thead>
          <tr>
            <th className="timestamp">Time</th>
            <th className="numeric">Market Price</th>
            <th className="numeric">Solar (W)</th>
            <th className="numeric">Demand (W)</th>
            <th className="numeric">End SOC %</th>
            <th className="numeric">Grid Power (W)</th>
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
            const oracle = findOracleForEra(era, oracleLookup);
            const solarLabel =
              solar.averageW !== null
                ? formatNumber(solar.averageW, " W")
                : solar.energyKwh !== null
                  ? formatNumber(solar.energyKwh, " kWh")
                  : "n/a";
            const r = typeof summary?.solar_direct_use_ratio === "number" && Number.isFinite(summary.solar_direct_use_ratio)
              ? summary.solar_direct_use_ratio
              : 0.6;
            const bp = typeof summary?.house_load_w === "number" && Number.isFinite(summary.house_load_w)
              ? summary.house_load_w
              : 0;
            const solarAvgForDemand = typeof solar.averageW === "number" && Number.isFinite(solar.averageW) ? (solar.averageW as number) : 0;
            const demandW = bp + r * solarAvgForDemand;
            const strategy = oracle?.strategy ?? "auto";
            const endSocValue = formatPercent(oracle?.end_soc_percent ?? oracle?.target_soc_percent ?? null);
            const targetLabel = oracle ? `${endSocValue} (${strategy.toUpperCase()})` : "n/a";
            const gridEnergyWh = oracle?.grid_energy_wh;
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
            const startLabel = era.start ? new Date(era.start) : null;
            const endLabel = era.end ? new Date(era.end) : null;
            const timeCell = startLabel
              ? `${dateTimeNoSecondsFormatter.format(startLabel)}${endLabel ? ` — ${timeFormatter.format(endLabel)}` : ""}`
              : "n/a";

            return (
              <tr key={era.era_id}>
                <td className="timestamp">{timeCell}</td>
                <td className="numeric">{marketCost && marketCost.priceCt !== null ? formatNumber(marketCost.priceCt, " ct/kWh") : "n/a"}</td>
                <td className="numeric">{solarLabel}</td>
                <td className="numeric">{formatNumber(demandW, " W")}</td>
                <td className="numeric">{targetLabel}</td>
                <td className="numeric">{gridPower}</td>
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
