import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Chart, ChartConfiguration, registerables } from "chart.js";

Chart.register(...registerables);

const numberFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const percentFormatter = new Intl.NumberFormat(undefined, {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
});

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

const REFRESH_INTERVAL_MS = 60_000;

type TrajectoryPoint = {
  slot_index: number;
  start: string | null;
  end: string | null;
  duration_hours: number;
  soc_start_percent: number;
  soc_end_percent: number;
  grid_energy_kwh: number;
  price_eur_per_kwh: number;
};

type HistoryPoint = {
  timestamp: string;
  battery_soc_percent?: number;
  price_eur_per_kwh?: number;
  grid_power_kw?: number;
  grid_energy_kwh?: number;
};

type SnapshotPayload = {
  timestamp: string | null;
  interval_seconds: number | null;
  house_load_w: number | null;
  current_soc_percent: number | null;
  next_step_soc_percent: number | null;
  recommended_soc_percent: number | null;
  recommended_final_soc_percent: number | null;
  price_snapshot_eur_per_kwh: string | number | null;
  projected_cost_eur: number | null;
  projected_grid_energy_kwh: number | null;
  forecast_hours: number | null;
  forecast_samples: number | null;
  trajectory: TrajectoryPoint[];
  history?: HistoryPoint[];
  warnings?: string[];
  errors?: string[];
};

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  return `${percentFormatter.format(value)}%`;
}

function formatNumber(value: number | null | undefined, unit = "") {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "n/a";
  }
  return `${numberFormatter.format(value)}${unit}`;
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "n/a";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return dateTimeFormatter.format(parsed);
}

function statusClass(errors?: string[], warnings?: string[]) {
  if (errors && errors.length) {
    return { label: "Errors", className: "status err" };
  }
  if (warnings && warnings.length) {
    return { label: "Warnings", className: "status warn" };
  }
  return { label: "OK", className: "status ok" };
}

function useProjectionChart(history: HistoryPoint[], trajectory: TrajectoryPoint[]) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    const hasHistory = Array.isArray(history) && history.length > 0;
    const hasTrajectory = Array.isArray(trajectory) && trajectory.length > 0;

    if (!hasHistory && !hasTrajectory) {
      chartRef.current?.destroy();
      chartRef.current = null;
      return undefined;
    }

    const sortedHistory = hasHistory
      ? [...history].sort(
          (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
        )
      : [];

    const historyDates = sortedHistory.map((item) => new Date(item.timestamp));
    const futureDates = hasTrajectory
      ? trajectory.map((item) => new Date(item.end ?? item.start ?? ''))
      : [];

    const historyLabels = historyDates.map((parsed, idx, arr) => {
      if (Number.isNaN(parsed.getTime())) {
        return sortedHistory[idx]?.timestamp ?? `Slot ${idx}`;
      }
      const isFirstOverall = idx === 0;
      const isLastOverall = !futureDates.length && idx === arr.length - 1;
      return isFirstOverall || isLastOverall
        ? dateTimeFormatter.format(parsed)
        : timeFormatter.format(parsed);
    });

    const futureLabels = futureDates.map((parsed, idx, arr) => {
      if (Number.isNaN(parsed.getTime())) {
        const slot = trajectory[idx];
        return slot ? `Slot ${slot.slot_index}` : `Slot ${idx}`;
      }
      const isFirstOverall = !historyDates.length && idx === 0;
      const isLastOverall = idx === arr.length - 1;
      return isFirstOverall || isLastOverall
        ? dateTimeFormatter.format(parsed)
        : timeFormatter.format(parsed);
    });

    const labels = [...historyLabels, 'Now', ...futureLabels];
    const historyCount = historyLabels.length;

    const historySoc = sortedHistory.map((item) =>
      typeof item.battery_soc_percent === 'number' ? item.battery_soc_percent : null
    );
    const futureSoc = hasTrajectory
      ? trajectory.map((item) => item.soc_end_percent ?? item.soc_start_percent ?? null)
      : [];

    const historyGrid = sortedHistory.map((item) =>
      typeof item.grid_energy_kwh === 'number' ? item.grid_energy_kwh : null
    );
    const futureGrid = hasTrajectory
      ? trajectory.map((item) => item.grid_energy_kwh ?? null)
      : [];

    const historyPrice = sortedHistory.map((item) =>
      typeof item.price_eur_per_kwh === 'number' ? item.price_eur_per_kwh : null
    );
    const futurePrice = hasTrajectory
      ? trajectory.map((item) => item.price_eur_per_kwh ?? null)
      : [];

    const socData = [...historySoc, null, ...futureSoc];
    const gridData = [...historyGrid, null, ...futureGrid];
    const priceData = [...historyPrice, null, ...futurePrice];

    const pastLineColor = '#94a3b8';
    const pastFillColor = 'rgba(148, 163, 184, 0.2)';
    const pastPointColor = '#e2e8f0';

    const futureSocColor = '#22c55e';
    const futureSocFill = 'rgba(34, 197, 94, 0.25)';
    const futureGridColor = '#f97316';
    const futureGridFill = 'rgba(249, 115, 22, 0.15)';
    const futurePriceColor = '#38bdf8';
    const futurePriceFill = 'rgba(56, 189, 248, 0.2)';

    const makeSegmentColor = (futureColor: string, futureFill: string) => ({
      borderColor: (ctx: any) =>
        ctx?.p0DataIndex !== undefined && ctx.p0DataIndex < historyCount
          ? pastLineColor
          : futureColor,
      backgroundColor: (ctx: any) =>
        ctx?.p0DataIndex !== undefined && ctx.p0DataIndex < historyCount
          ? pastFillColor
          : futureFill,
    });

    const pointColor = (ctx: any, futureColor: string) =>
      ctx.dataIndex < historyCount ? pastPointColor : futureColor;

    chartRef.current?.destroy();

    const canvas = canvasRef.current;
    if (!canvas) {
      return undefined;
    }

    const config: ChartConfiguration = {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Target SOC %",
            data: socData,
            borderColor: futureSocColor,
            backgroundColor: futureSocFill,
            yAxisID: "y",
            tension: 0.25,
            fill: true,
            spanGaps: true,
            segment: makeSegmentColor(futureSocColor, futureSocFill),
            pointRadius: (ctx) => (ctx.dataIndex < historyCount ? 3 : 4),
            pointBackgroundColor: (ctx) => pointColor(ctx, futureSocColor),
            pointBorderColor: (ctx) => pointColor(ctx, futureSocColor),
          },
          {
            label: "Grid Energy (kWh)",
            data: gridData,
            borderColor: futureGridColor,
            backgroundColor: futureGridFill,
            yAxisID: "y1",
            tension: 0.2,
            spanGaps: true,
            segment: makeSegmentColor(futureGridColor, futureGridFill),
            pointRadius: (ctx) => (ctx.dataIndex < historyCount ? 3 : 4),
            pointBackgroundColor: (ctx) => pointColor(ctx, futureGridColor),
            pointBorderColor: (ctx) => pointColor(ctx, futureGridColor),
          },
          {
            label: "Price (€/kWh)",
            data: priceData,
            borderColor: futurePriceColor,
            backgroundColor: futurePriceFill,
            yAxisID: "y2",
            tension: 0.2,
            spanGaps: true,
            segment: makeSegmentColor(futurePriceColor, futurePriceFill),
            pointRadius: (ctx) => (ctx.dataIndex < historyCount ? 3 : 4),
            pointBackgroundColor: (ctx) => pointColor(ctx, futurePriceColor),
            pointBorderColor: (ctx) => pointColor(ctx, futurePriceColor),
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        scales: {
          y: {
            type: "linear",
            position: "left",
            suggestedMin: 0,
            suggestedMax: 100,
            ticks: {
              callback: (value) => `${value}%`,
            },
          },
          y1: {
            type: "linear",
            position: "right",
            grid: {
              drawOnChartArea: false,
            },
          },
          y2: {
            type: "linear",
            position: "right",
            grid: {
              drawOnChartArea: false,
            },
            ticks: {
              callback: (value) => `${numberFormatter.format(Number(value))} €/kWh`,
            },
            offset: true,
          },
        },
        plugins: {
          legend: {
            labels: {
              color: "#f8fafc",
            },
          },
        },
      },
    };

    chartRef.current = new Chart(canvas, config);

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, [history, trajectory]);

  return canvasRef;
}

type MessageListProps = {
  items?: string[];
  tone: "warning" | "error";
};

function MessageList({ items, tone }: MessageListProps) {
  if (!items || items.length === 0) {
    return null;
  }
  const className = tone === "error" ? "status err" : "status warn";
  const heading = tone === "error" ? "Errors" : "Warnings";
  return (
    <section className="card">
      <h2>{heading}</h2>
      <ul>
        {items.map((item, idx) => (
          <li key={`${tone}-${idx}`}>
            <span className={className}>{heading.slice(0, -1)}</span>
            &nbsp;{item}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SummaryCards({ data }: { data: SnapshotPayload | null }) {
  if (!data) {
    return null;
  }
  const { label, className } = statusClass(data.errors, data.warnings);

  const hasCommand = typeof data.recommended_soc_percent === "number";
  const actionLabel = (() => {
    if (!hasCommand) {
      return "No action";
    }
    const current = data.current_soc_percent ?? 0;
    const next = data.next_step_soc_percent ?? current;
    const target = data.recommended_final_soc_percent ?? data.recommended_soc_percent ?? next;
    if (target > current + 0.5) {
      return `Charge towards ${formatPercent(target)}`;
    }
    if (target < current - 0.5) {
      return `Discharge towards ${formatPercent(target)}`;
    }
    if (next > current + 0.5) {
      return `Increase SOC towards ${formatPercent(next)}`;
    }
    if (next < current - 0.5) {
      return `Lower SOC towards ${formatPercent(next)}`;
    }
    return `Hold around ${formatPercent(current)}`;
  })();

  return (
    <section className="card">
      <div className="grid">
        <div className="metric strategy">
          <span className="label">Current Strategy</span>
          <span className="value strategy">{actionLabel}</span>
        </div>
        <div className="metric">
          <span className="label">Status</span>
          <span className={className}>{label}</span>
        </div>
        <div className="metric">
          <span className="label">Current SOC</span>
          <span className="value">{formatPercent(data.current_soc_percent)}</span>
        </div>
        <div className="metric">
          <span className="label">Next Target</span>
          <span className="value">{formatPercent(data.next_step_soc_percent)}</span>
        </div>
        <div className="metric">
          <span className="label">Recommended Final</span>
          <span className="value">{formatPercent(data.recommended_final_soc_percent)}</span>
        </div>
        <div className="metric">
          <span className="label">Current Strategy</span>
          <span className="value small">{actionLabel}</span>
        </div>
        <div className="metric">
          <span className="label">Price Snapshot</span>
          <span className="value small">{formatNumber(Number(data.price_snapshot_eur_per_kwh), " €/kWh")}</span>
        </div>
        <div className="metric">
          <span className="label">Projected Cost</span>
          <span className="value small">{formatNumber(data.projected_cost_eur, " €")}</span>
        </div>
        <div className="metric">
          <span className="label">Projected Grid Energy</span>
          <span className="value small">{formatNumber(data.projected_grid_energy_kwh, " kWh")}</span>
        </div>
      </div>
      <small className="timestamp">Last update: {formatDate(data.timestamp)}</small>
    </section>
  );
}

type TrajectoryTableProps = {
  trajectory: TrajectoryPoint[];
};

function TrajectoryTable({ trajectory }: TrajectoryTableProps) {
  if (!trajectory.length) {
    return (
      <section className="card">
        <p>No trajectory data available.</p>
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
              <th>Slot</th>
              <th>Start</th>
              <th>End</th>
              <th>Target SOC %</th>
              <th>Grid Energy (kWh)</th>
              <th>Price (€/kWh)</th>
            </tr>
          </thead>
          <tbody>
            {trajectory.map((item) => {
              const target = item.soc_end_percent ?? item.soc_start_percent;
              return (
                <tr key={item.slot_index}>
                  <td>{item.slot_index}</td>
                  <td>{formatDate(item.start)}</td>
                  <td>{formatDate(item.end)}</td>
                  <td>{formatPercent(target)}</td>
                  <td>{formatNumber(item.grid_energy_kwh)}</td>
                  <td>{formatNumber(item.price_eur_per_kwh)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type HistoryTableProps = {
  history: HistoryPoint[];
};

function HistoryTable({ history }: HistoryTableProps) {
  if (!history.length) {
    return null;
  }

  const rows = [...history].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return (
    <section className="card">
      <h2>Recent History</h2>
      <div className="table-wrapper">
        <table>
          <thead>
            <tr>
              <th>Timestamp</th>
              <th>Battery SOC %</th>
              <th>Price (€/kWh)</th>
              <th>Grid Power (kW)</th>
              <th>Grid Energy (kWh)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((item, idx) => (
              <tr key={`${item.timestamp}-${idx}`}>
                <td>{formatDate(item.timestamp)}</td>
                <td>{formatPercent(item.battery_soc_percent ?? null)}</td>
                <td>{
                  typeof item.price_eur_per_kwh === 'number'
                    ? formatNumber(item.price_eur_per_kwh, ' €/kWh')
                    : 'n/a'
                }</td>
                <td>{
                  typeof item.grid_power_kw === 'number'
                    ? formatNumber(item.grid_power_kw, ' kW')
                    : 'n/a'
                }</td>
                <td>{
                  typeof item.grid_energy_kwh === 'number'
                    ? formatNumber(item.grid_energy_kwh, ' kWh')
                    : 'n/a'
                }</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const App = () => {
  const [data, setData] = useState<SnapshotPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMockSnapshot = useCallback(async () => {
    if (!import.meta.env.DEV || import.meta.env.VITE_USE_MOCK !== "true") {
      return false;
    }
    try {
      const module = await import("./mock/latest-mock.json");
      setData(module.default as SnapshotPayload);
      setError(null);
      return true;
    } catch (mockErr) {
      console.warn("failed to load mock snapshot", mockErr);
      return false;
    }
  }, []);

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch(`/data/latest.json?t=${Date.now()}`);
      if (!response.ok) {
        throw new Error(`Failed to load snapshot (${response.status})`);
      }
      const payload: SnapshotPayload = await response.json();
      setData(payload);
      setError(null);
    } catch (err) {
      const loadedMock = await loadMockSnapshot();
      if (!loadedMock) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, [loadMockSnapshot]);

  useEffect(() => {
    fetchData();
    const interval = setInterval(fetchData, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  const trajectory = useMemo(
    () => (data && Array.isArray(data.trajectory) ? data.trajectory : []),
    [data]
  );
  const history = useMemo(
    () => (data && Array.isArray(data.history) ? data.history : []),
    [data]
  );
  const chartRef = useProjectionChart(history, trajectory);

  return (
    <>
      {error ? (
        <section className="card">
          <p className="status err">{error}</p>
        </section>
      ) : null}

      <SummaryCards data={data} />

      <section className="card chart">
        <h2>SOC over time</h2>
        <canvas ref={chartRef} aria-label="SOC projection chart" />
      </section>

      <TrajectoryTable trajectory={trajectory} />

      <HistoryTable history={history} />

      <MessageList items={data?.warnings} tone="warning" />
      <MessageList items={data?.errors} tone="error" />

      <section className="card banner">
        <div>
          <h2>Latest Optimisation</h2>
          <p>Live data reloads every minute from batteryctl.</p>
        </div>
        <button
          type="button"
          className="refresh-button"
          onClick={fetchData}
          disabled={loading}
        >
          {loading ? "Refreshing..." : "Refresh now"}
        </button>
      </section>
    </>
  );
};

export default App;
