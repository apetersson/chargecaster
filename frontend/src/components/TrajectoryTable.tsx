import { buildDerivedForecastEras } from "@chargecaster/domain";
import { type JSX, useMemo } from "react";

import type { ForecastEra, OracleEntry, SnapshotSummary } from "../types";
import { dateTimeNoSecondsFormatter, formatNumber, formatPercent, timeFormatter } from "../utils/format";

type TrajectoryTableProps = {
  forecast: ForecastEra[];
  oracleEntries: OracleEntry[];
  summary?: SnapshotSummary | null;
};

type TrajectoryRow = {
  key: string;
  timeCell: string;
  marketPriceLabel: string;
  solarLabel: string;
  demandLabel: string;
  targetLabel: string;
  gridPowerLabel: string;
};

function buildTrajectoryRows(
  forecast: ForecastEra[],
  oracleEntries: OracleEntry[],
  summary: SnapshotSummary | null | undefined,
  now: number,
): TrajectoryRow[] {
  return buildDerivedForecastEras(forecast, oracleEntries, summary, now).map((era) => {
    const solarLabel =
      era.solarAveragePower !== null
        ? formatNumber(era.solarAveragePower.watts, " W")
        : era.solarEnergy !== null
          ? formatNumber(era.solarEnergy.kilowattHours, " kWh")
          : "n/a";
    const endSocValue = formatPercent(era.targetSoc?.percent ?? null);
    const targetLabel = era.strategy ? `${endSocValue} (${era.strategy.toUpperCase()})` : "n/a";
    const timeCell =
      `${dateTimeNoSecondsFormatter.format(era.slot.start)} — ${timeFormatter.format(era.slot.end)}`;

    return {
      key: era.era.era_id,
      timeCell,
      marketPriceLabel: era.price !== null ? formatNumber(era.price.ctPerKwh, " ct/kWh") : "n/a",
      solarLabel,
      demandLabel: formatNumber(era.demandPower.watts, " W"),
      targetLabel,
      gridPowerLabel: era.gridPower !== null ? formatNumber(era.gridPower.watts, " W") : "n/a",
    };
  });
}

function TrajectoryTable({forecast, oracleEntries, summary}: TrajectoryTableProps): JSX.Element {
  const rows = useMemo(
    () => buildTrajectoryRows(forecast, oracleEntries, summary, Date.now()),
    [forecast, oracleEntries, summary],
  );

  if (!rows.length) {
    return (<section className="card"><p>No forecast data available.</p></section>);
  }

  return (
    <section className="card">
      <h2>Forecast Horizon</h2>
      <div className="table-wrapper">
        <table className="forecast-table">
          <colgroup>
            <col className="col-time"/>
            <col className="col-price"/>
            <col className="col-solar"/>
            <col className="col-power"/>
            <col className="col-soc"/>
            <col className="col-power"/>
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
          {rows.map((row) => (
            <tr key={row.key}>
              <td className="timestamp">{row.timeCell}</td>
              <td className="numeric">{row.marketPriceLabel}</td>
              <td className="numeric">{row.solarLabel}</td>
              <td className="numeric">{row.demandLabel}</td>
              <td className="numeric">{row.targetLabel}</td>
              <td className="numeric">{row.gridPowerLabel}</td>
            </tr>
          ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default TrajectoryTable;
