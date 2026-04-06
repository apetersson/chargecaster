import { type JSX, useMemo } from "react";
import { buildOracleLookup, resolveOracleEntryForEra } from "@chargecaster/domain";

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
  planningPriceLabel: string;
  proposedActionLabel: string;
  solarLabel: string;
  demandLabel: string;
  targetLabel: string;
  gridPowerLabel: string;
};

type CostSource = Extract<ForecastEra["sources"][number], { type: "cost" }>;

function resolvePrimaryCostSource(era: ForecastEra): CostSource | undefined {
  return era.sources.find((source): source is CostSource => source.type === "cost" && source.provider === "canonical")
    ?? era.sources.find((source): source is CostSource => source.type === "cost");
}

function formatCostSource(source: CostSource | undefined): string {
  if (!source) {
    return "n/a";
  }
  return formatNumber(source.payload.price_with_fee_ct_per_kwh, " ct/kWh");
}

function buildProposedActionDetail(
  oracle: OracleEntry | undefined,
): string {
  if (!oracle?.strategy) {
    return "n/a";
  }
  const targetPercent = oracle.target_soc_percent ?? oracle.end_soc_percent ?? oracle.start_soc_percent ?? null;
  const targetLabel = targetPercent != null ? formatPercent(targetPercent) : null;

  switch (oracle.strategy) {
    case "charge":
      return targetLabel ? `Charge to ${targetLabel}` : "Charge";
    case "hold":
      return targetLabel ? `Hold at ${targetLabel}` : "Hold";
    case "limit":
      return targetLabel ? `Limit to ${targetLabel}` : "Limit";
    case "auto":
      return "Auto";
    default:
      return "n/a";
  }
}

function buildTrajectoryRows(
  forecast: ForecastEra[],
  demandForecast: DemandForecastEntry[],
  oracleEntries: OracleEntry[],
): TrajectoryRow[] {
  const oracleLookup = buildOracleLookup(oracleEntries);
  const demandByStart = new Map(demandForecast.map((entry) => [entry.start, entry]));
  return forecast.flatMap((era) => {
    const demand = era.start ? demandByStart.get(era.start) : undefined;
    const oracle = resolveOracleEntryForEra(era, oracleLookup);
    const start = era.start ? new Date(era.start) : null;
    const end = era.end ? new Date(era.end) : null;
    const solarSource = era.sources.find((source) => source.type === "solar");
    const planningCostSource = resolvePrimaryCostSource(era);
    if (!start || !end) {
      return [];
    }
    const targetPercent = oracle?.target_soc_percent ?? oracle?.end_soc_percent ?? null;
    const endSocValue = formatPercent(targetPercent);
    const targetLabel = oracle?.strategy ? `${endSocValue} (${oracle.strategy.toUpperCase()})` : "n/a";
    return [{
      key: era.era_id,
      timeCell: `${dateTimeNoSecondsFormatter.format(start)} — ${timeFormatter.format(end)}`,
      planningPriceLabel: formatCostSource(planningCostSource),
      proposedActionLabel: buildProposedActionDetail(oracle),
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
            <col className="col-price"/>
            <col className="col-solar"/>
            <col className="col-power"/>
            <col className="col-soc"/>
            <col className="col-power"/>
          </colgroup>
          <thead>
          <tr>
            <th className="timestamp">Time</th>
            <th className="numeric">Planning Price</th>
            <th className="numeric">Proposed Action</th>
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
              <td className="numeric">{row.planningPriceLabel}</td>
              <td className="numeric">{row.proposedActionLabel}</td>
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
