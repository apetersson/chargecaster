import { useCallback, useEffect, useState } from "react";

import HistoryTable from "./components/HistoryTable";
import MessageList from "./components/MessageList";
import SummaryCards from "./components/SummaryCards";
import TrajectoryTable from "./components/TrajectoryTable";
import { trpcClient } from "./api/trpc";
import { useProjectionChart } from "./hooks/useProjectionChart";
import type { HistoryPoint, SnapshotSummary, TrajectoryPoint } from "./types";

const REFRESH_INTERVAL_MS = 60_000;
const mockEnabled = import.meta.env.DEV && import.meta.env.VITE_USE_MOCK === "true";

const toNumber = (value: unknown): number | null => {
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
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }
  return null;
};

const toTimestamp = (value: unknown): string => {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
};

const normalizeHistoryEntry = (entry: unknown): HistoryPoint => {
  const record = (entry ?? {}) as Record<string, unknown>;
  return {
    timestamp: toTimestamp(record.timestamp),
    battery_soc_percent: toNumber(record.battery_soc_percent),
    price_eur_per_kwh: toNumber(record.price_eur_per_kwh),
    grid_power_kw: toNumber(record.grid_power_kw),
    grid_energy_kwh: toNumber(record.grid_energy_kwh),
  };
};

const normalizeTrajectoryPoint = (entry: unknown): TrajectoryPoint => {
  const record = (entry ?? {}) as Record<string, unknown>;
  const start = toTimestamp(record.start);
  const end = toTimestamp(record.end);
  const slotIndex = Number(record.slot_index);
  return {
    slot_index: Number.isFinite(slotIndex) ? slotIndex : 0,
    start,
    end,
    duration_hours: toNumber(record.duration_hours) ?? 0,
    soc_start_percent: toNumber(record.soc_start_percent) ?? 0,
    soc_end_percent: toNumber(record.soc_end_percent) ?? 0,
    grid_energy_kwh: toNumber(record.grid_energy_kwh) ?? 0,
    price_eur_per_kwh: toNumber(record.price_eur_per_kwh) ?? 0,
  };
};

const App = () => {
  const [summary, setSummary] = useState<SnapshotSummary | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [trajectory, setTrajectory] = useState<TrajectoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMockSnapshot = useCallback(async () => {
    if (!mockEnabled) {
      return false;
    }
    try {
      const mockModule = await import("./mock/latest-mock.json");
      const payload = mockModule.default as Record<string, unknown>;

      const summaryPayload: SnapshotSummary = {
        timestamp: toTimestamp(payload.timestamp),
        interval_seconds: toNumber(payload.interval_seconds),
        house_load_w: toNumber(payload.house_load_w),
        current_soc_percent: toNumber(payload.current_soc_percent),
        next_step_soc_percent: toNumber(payload.next_step_soc_percent),
        recommended_soc_percent: toNumber(payload.recommended_soc_percent),
        recommended_final_soc_percent: toNumber(payload.recommended_final_soc_percent),
        price_snapshot_eur_per_kwh: toNumber(payload.price_snapshot_eur_per_kwh),
        projected_cost_eur: toNumber(payload.projected_cost_eur),
        projected_grid_energy_kwh: toNumber(payload.projected_grid_energy_kwh),
        forecast_hours: toNumber(payload.forecast_hours),
        forecast_samples: toNumber(payload.forecast_samples),
        warnings: Array.isArray(payload.warnings)
          ? (payload.warnings as string[])
          : [],
        errors: Array.isArray(payload.errors) ? (payload.errors as string[]) : [],
      };

      const historyEntries = Array.isArray(payload.history)
        ? payload.history.map((entry) => normalizeHistoryEntry(entry))
        : [];
      const trajectoryPoints = Array.isArray(payload.trajectory)
        ? payload.trajectory.map((entry) => normalizeTrajectoryPoint(entry))
        : [];

      setSummary(summaryPayload);
      setHistory(historyEntries);
      setTrajectory(trajectoryPoints);
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
      const [summaryData, historyData, trajectoryData] = await Promise.all([
        trpcClient.dashboard.summary.query(),
        trpcClient.dashboard.history.query(),
        trpcClient.dashboard.trajectory.query(),
      ]);

      setSummary(summaryData);
      setHistory(historyData.entries ?? []);
      setTrajectory(trajectoryData.points ?? []);
      setError(null);
    } catch (err) {
      if (mockEnabled) {
        const loadedMock = await loadMockSnapshot();
        if (!loadedMock) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, [loadMockSnapshot]);

  useEffect(() => {
    void fetchData();
    const interval = setInterval(() => {
      void fetchData();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  const chartRef = useProjectionChart(history, trajectory);

  return (
    <>
      {error ? (
        <section className="card">
          <p className="status err">{error}</p>
        </section>
      ) : null}

      <SummaryCards data={summary} />

      <section className="card chart">
        <h2>SOC over time</h2>
        <canvas ref={chartRef} aria-label="SOC projection chart" />
      </section>

      <TrajectoryTable trajectory={trajectory} />

      <HistoryTable history={history} />

      <MessageList items={summary?.warnings} tone="warning" />
      <MessageList items={summary?.errors} tone="error" />

      <section className="card banner">
        <div>
          <h2>Latest Optimisation</h2>
          <p>Live data reloads every minute from batteryctl.</p>
        </div>
        <button
          type="button"
          className="refresh-button"
          onClick={() => {
            void fetchData();
          }}
          disabled={loading}
        >
          {loading ? "Refreshing..." : "Refresh now"}
        </button>
      </section>
    </>
  );
};

export default App;
