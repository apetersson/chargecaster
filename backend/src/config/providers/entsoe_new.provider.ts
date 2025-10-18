import { MarketProvider, MarketProviderContext, MarketProviderResult } from "./provider.types";
import type { RawForecastEntry } from "../../simulation/types";
import type { EntsoeNewConfig } from "../schemas";
import { clampHorizon, derivePriceSnapshotFromForecast } from "./provider.utils";

const BASE_URL = "https://newtransparency.entsoe.eu/market/energyPrices/load";
const REQUEST_TIMEOUT_MS = 15000;
const SLOT_15M_MS = 15 * 60 * 1000;

export class EntsoeNewProvider implements MarketProvider {
  readonly key = "entsoe";
  constructor(private readonly cfg?: EntsoeNewConfig) {}

  async collect(ctx: MarketProviderContext): Promise<MarketProviderResult> {
    try {
      const ranges = this.buildDayWindows(this.cfg?.max_hours ?? 72);
      let all: RawForecastEntry[] = [];
      for (const [fromIso, toIso] of ranges) {
        const payload = await this.fetchCurve(fromIso, toIso);
        const entries = this.parseCurve(payload);
        all = all.concat(entries);
      }
      let forecast = clampHorizon(all, this.cfg?.max_hours ?? 72);
      if (this.cfg?.aggregate_hourly) {
        forecast = this.aggregateToHourly(forecast);
      }
      const priceSnapshot = derivePriceSnapshotFromForecast(forecast, ctx.simulationConfig);
      return {forecast, priceSnapshot};
    } catch (error) {
      ctx.warnings.push(`ENTSOE new-transparency fetch failed: ${this.describeError(error)}`);
      return {forecast: [], priceSnapshot: null};
    }
  }

  private buildDayWindows(maxHours: number): [string, string][] {
    const now = Date.now();
    const end = now + Math.max(1, maxHours) * 3_600_000;
    const result: [string, string][] = [];
    // Build UTC day windows [00:00Z, 00:00Z+24h]
    let cursor = new Date(now);
    cursor.setUTCHours(0, 0, 0, 0);
    // If now is past midnight, include a window starting today
    if (cursor.getTime() > now) {
      cursor = new Date(cursor.getTime() - 24 * 3_600_000);
    }
    while (cursor.getTime() < end) {
      const from = cursor.toISOString();
      const to = new Date(cursor.getTime() + 24 * 3_600_000).toISOString();
      result.push([from, to]);
      cursor = new Date(cursor.getTime() + 24 * 3_600_000);
    }
    return result;
  }

  private async fetchCurve(fromIso: string, toIso: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const body = {
        dateTimeRange: {from: fromIso, to: toIso},
        areaList: [String(this.cfg?.zone ?? "")],
        timeZone: String(this.cfg?.tz ?? "CET"),
        intervalPageInfo: {itemIndex: 0, pageSize: 10},
        filterMap: {},
      };
      const headers = {
        "Accept": "application/json",
        "Content-Type": "application/json; charset=utf-8",
      } as Record<string, string>;
      const response = await fetch(BASE_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  // Response types (partial) for safer access
  private parseCurve(payload: unknown): RawForecastEntry[] {
    interface Period {
      timeInterval?: {from?: string; to?: string};
      resolution?: string;
      pointMap?: Record<string, string[]>;
    }
    interface Instance { curveData?: { periodList?: Period[] } }
    interface Root { instanceList?: Instance[] }
    const out: RawForecastEntry[] = [];
    const root = (payload ?? {}) as Root;
    const instances = Array.isArray(root.instanceList) ? root.instanceList : [];
    for (const inst of instances) {
      const list = inst.curveData?.periodList;
      const periodList: Period[] = Array.isArray(list) ? list : [];
      for (const period of periodList) {
        const fromZ = Date.parse(period.timeInterval?.from ?? "");
        const toZ = Date.parse(period.timeInterval?.to ?? "");
        const resolution = String(period.resolution ?? "PT15M");
        if (!Number.isFinite(fromZ) || !Number.isFinite(toZ)) continue;
        const stepMs = this.parseDurationMs(resolution) ?? SLOT_15M_MS;
        const pointMap = period.pointMap ?? {};
        const keys = Object.keys(pointMap).sort((a, b) => Number(a) - Number(b));
        for (const k of keys) {
          const idx = Number(k);
          if (!Number.isFinite(idx)) continue;
          const arr = pointMap[k];
          const rawVal = Array.isArray(arr) && arr.length ? Number(arr[0]) : NaN;
          if (!Number.isFinite(rawVal)) continue;
          const startMs = fromZ + idx * stepMs;
          const endMs = Math.min(startMs + stepMs, toZ);
          const startIso = new Date(startMs).toISOString();
          const endIso = new Date(endMs).toISOString();
          const eurPerKwh = rawVal / 1000;
          out.push({
            start: startIso,
            end: endIso,
            price: eurPerKwh,
            unit: "EUR/kWh",
            price_ct_per_kwh: eurPerKwh * 100,
            price_with_fee_ct_per_kwh: null,
            price_with_fee_eur_per_kwh: null,
            duration_hours: (endMs - startMs) / 3_600_000,
          });
        }
      }
    }
    return out;
  }

  private parseDurationMs(value: string | null | undefined): number | null {
    if (!value) return null;
    const v = value.toUpperCase().trim();
    // Common ISO-8601 patterns from ENTSO-E: PT15M, PT30M, PT60M, PT1H
    const m = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(v);
    if (m) {
      const hours = m[1] ? Number(m[1]) : 0;
      const minutes = m[2] ? Number(m[2]) : 0;
      if (Number.isFinite(hours) && Number.isFinite(minutes)) {
        return (hours * 60 + minutes) * 60 * 1000;
      }
    }
    return null;
  }

  private aggregateToHourly(entries: RawForecastEntry[]): RawForecastEntry[] {
    if (!entries.length) return [];
    // Group by UTC hour start and compute time-weighted average price
    const groups = new Map<number, { sumPriceHours: number; sumHours: number }>();
    for (const e of entries) {
      const s = Date.parse(String(e.start ?? e.from ?? ""));
      const en = Date.parse(String(e.end ?? e.to ?? ""));
      if (!Number.isFinite(s) || !Number.isFinite(en) || en <= s) continue;
      const hourStart = new Date(s);
      hourStart.setUTCMinutes(0, 0, 0);
      const key = hourStart.getTime();
      const durationHours = (en - s) / 3_600_000;
      const price = typeof e.price === "number" && Number.isFinite(e.price)
        ? e.price
        : typeof e.price_ct_per_kwh === "number" && Number.isFinite(e.price_ct_per_kwh)
          ? e.price_ct_per_kwh / 100
          : null;
      if (price === null || durationHours <= 0) continue;
      const acc = groups.get(key) ?? {sumPriceHours: 0, sumHours: 0};
      acc.sumPriceHours += price * durationHours;
      acc.sumHours += durationHours;
      groups.set(key, acc);
    }
    const result: RawForecastEntry[] = [];
    const keys = [...groups.keys()].sort((a, b) => a - b);
    for (const key of keys) {
      const {sumPriceHours, sumHours} = groups.get(key)!;
      if (sumHours <= 0) continue;
      const priceEur = sumPriceHours / sumHours;
      const startIso = new Date(key).toISOString();
      const endIso = new Date(key + 3_600_000).toISOString();
      result.push({
        start: startIso,
        end: endIso,
        price: priceEur,
        unit: "EUR/kWh",
        price_ct_per_kwh: priceEur * 100,
        price_with_fee_ct_per_kwh: null,
        price_with_fee_eur_per_kwh: null,
        duration_hours: 1,
      });
    }
    return result;
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }
}
