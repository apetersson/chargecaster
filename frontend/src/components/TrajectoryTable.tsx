import { type JSX, useMemo } from "react";

import type { DemandForecastEntry, ForecastEra, OracleEntry } from "../types";
import { dateTimeNoSecondsFormatter, formatNumber, formatPercent, timeFormatter } from "../utils/format";

type TrajectoryTableProps = {
  forecast: ForecastEra[];
  demandForecast: DemandForecastEntry[];
  oracleEntries: OracleEntry[];
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
  demandForecast: DemandForecastEntry[],
  oracleEntries: OracleEntry[],
): TrajectoryRow[] {
  const oracleByEraId = new Map(oracleEntries.map((entry) => [entry.era_id, entry]));
  const demandByStart = new Map(demandForecast.map((entry) => [entry.start, entry]));
  return forecast.flatMap((era) => {
    const demand = era.start ? demandByStart.get(era.start) : undefined;
    const oracle = oracleByEraId.get(era.era_id);
    const start = era.start ? new Date(era.start) : null;
    const end = era.end ? new Date(era.end) : null;
    const solarSource = era.sources.find((source) => source.type === "solar");
    const costSource = era.sources.find((source) => source.type === "cost");
    if (!start || !end) {
      return [];
    }
    const targetPercent = oracle?.target_soc_percent ?? oracle?.end_soc_percent ?? null;
    const endSocValue = formatPercent(targetPercent);
    const targetLabel = oracle?.strategy ? `${endSocValue} (${oracle.strategy.toUpperCase()})` : "n/a";
    return [{
      key: era.era_id,
      timeCell: `${dateTimeNoSecondsFormatter.format(start)} — ${timeFormatter.format(end)}`,
      marketPriceLabel: costSource ? formatNumber(costSource.payload.price_with_fee_ct_per_kwh, " ct/kWh") : "n/a",
      solarLabel: solarSource ? formatNumber(solarSource.payload.average_power_w ?? solarSource.payload.energy_wh, " W") : "n/a",
      demandLabel: demand ? formatNumber(demand.house_power_w, " W") : "n/a",
      targetLabel,
      gridPowerLabel: oracle?.grid_energy_wh != null && era.duration_hours
        ? formatNumber(oracle.grid_energy_wh / era.duration_hours, " W")
        : "n/a",
    }];
  });
}

function TrajectoryTable({forecast, demandForecast, oracleEntries}: TrajectoryTableProps): JSX.Element {
  const rows = useMemo(
    () => buildTrajectoryRows(forecast, demandForecast, oracleEntries),
    [forecast, demandForecast, oracleEntries],
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
