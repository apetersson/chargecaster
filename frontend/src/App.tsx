import { useCallback, useEffect, useMemo, useState } from "react";

import HistoryTable from "./components/HistoryTable";
import MessageList from "./components/MessageList";
import SummaryCards from "./components/SummaryCards";
import TrajectoryTable from "./components/TrajectoryTable";
import { useProjectionChart } from "./hooks/useProjectionChart";
import type { HistoryPoint, SnapshotPayload, TrajectoryPoint } from "./types";

const isSnapshotPayload = (input: unknown): input is SnapshotPayload => {
  if (!input || typeof input !== "object") {
    return false;
  }
  const candidate = input as Record<string, unknown>;
  return "timestamp" in candidate && "interval_seconds" in candidate;
};

const REFRESH_INTERVAL_MS = 60_000;

const App = () => {
  const [data, setData] = useState<SnapshotPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadMockSnapshot = useCallback(async () => {
    if (!import.meta.env.DEV || import.meta.env.VITE_USE_MOCK !== "true") {
      return false;
    }
    try {
      const mockModule = (await import("./mock/latest-mock.json")) as {
        default: SnapshotPayload;
      };
      setData(mockModule.default);
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
      const payload = (await response.json()) as unknown;
      if (!isSnapshotPayload(payload)) {
        throw new Error("Snapshot payload malformed");
      }
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
    void fetchData();
    const interval = setInterval(() => {
      void fetchData();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [fetchData]);

  const trajectory = useMemo<TrajectoryPoint[]>(
    () => (data && Array.isArray(data.trajectory) ? data.trajectory : []),
    [data]
  );
  const history = useMemo<HistoryPoint[]>(
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
