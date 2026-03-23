import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FroniusService } from "../src/fronius/fronius.service";

const digestChallenge = () =>
  new Response(null, {
    status: 401,
    headers: {
      "www-authenticate": 'Digest realm="Webinterface area", nonce="nonce-1", qop="auth"',
    },
  });

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });

const createService = () =>
  new FroniusService({
    getDocumentRef: () => ({
      dry_run: false,
      fronius: {
        enabled: true,
        host: "http://inverter.local",
        user: "technician",
        password: "secret",
      },
      battery: {
        capacity_kwh: 10,
        max_charge_power_w: 4000,
        auto_mode_floor_soc: 5,
      },
      location: {
        timezone: "Europe/Vienna",
      },
      logic: {
        interval_seconds: 300,
      },
    }),
  } as never);

describe("FroniusService", () => {
  const requests: {url: string; method: string; body: string | null}[] = [];

  beforeEach(() => {
    requests.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("applies manual charging and activates a managed CHARGE_MIN time-of-use entry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-20T19:30:15+01:00"));

    const responses = [
      digestChallenge(),
      jsonResponse({}),
      jsonResponse({}),
      jsonResponse({
        timeofuse: [
          {
            Active: true,
            Power: 1500,
            ScheduleType: "CHARGE_MIN",
            TimeTable: {Start: "12:00", End: "13:00"},
            Weekdays: {Mon: true, Tue: true, Wed: true, Thu: true, Fri: true, Sat: true, Sun: true},
          },
        ],
      }),
      jsonResponse({writeSuccess: ["timeofuse"]}),
      jsonResponse({}),
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn((input: URL | string, init?: RequestInit) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        const next = responses.shift();
        if (!next) {
          throw new Error("Unexpected fetch call");
        }
        return next;
      }),
    );

    const service = createService();
    const result = await service.applyOptimization({
      charge: {untilTimestamp: "2026-03-20T22:15:00+01:00"},
    });

    expect(result.errorMessage).toBeNull();

    const batteryPost = requests.find((request) =>
      request.method === "POST" && request.url.endsWith("/api/config/batteries")
    );
    expect(batteryPost?.body).toBe(JSON.stringify({
      BAT_M0_SOC_MIN: 100,
      BAT_M0_SOC_MODE: "manual",
    }));

    const touPost = requests.find((request) =>
      request.method === "POST" && request.url.endsWith("/api/config/timeofuse")
    );
    expect(JSON.parse(touPost?.body ?? "{}")).toEqual({
      timeofuse: [
        {
          Active: true,
          Power: 1500,
          ScheduleType: "CHARGE_MIN",
          TimeTable: {Start: "12:00", End: "13:00"},
          Weekdays: {Mon: true, Tue: true, Wed: true, Thu: true, Fri: true, Sat: true, Sun: true},
        },
        {
          Active: true,
          Power: 4000,
          ScheduleType: "CHARGE_MIN",
          TimeTable: {Start: "19:30", End: "22:15"},
          Weekdays: {Mon: false, Tue: false, Wed: false, Thu: false, Fri: true, Sat: false, Sun: false},
        },
      ],
    });
  });

  it("keeps the managed entry but toggles it inactive when leaving charge mode", async () => {
    vi.useFakeTimers();

    const service = createService();

    vi.setSystemTime(new Date("2026-03-20T19:30:15+01:00"));
    let responses = [
      digestChallenge(),
      jsonResponse({}),
      jsonResponse({}),
      jsonResponse({timeofuse: []}),
      jsonResponse({writeSuccess: ["timeofuse"]}),
      jsonResponse({}),
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: URL | string, init?: RequestInit) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        const next = responses.shift();
        if (!next) {
          throw new Error("Unexpected fetch call");
        }
        return next;
      }),
    );

    await service.applyOptimization({
      charge: {untilTimestamp: "2026-03-20T22:15:00+01:00"},
    });

    vi.setSystemTime(new Date("2026-03-20T22:16:00+01:00"));
    responses = [
      digestChallenge(),
      jsonResponse({}),
      jsonResponse({}),
      jsonResponse({
        timeofuse: [
          {
            Active: true,
            Power: 4000,
            ScheduleType: "CHARGE_MIN",
            TimeTable: {Start: "19:30", End: "22:15"},
            Weekdays: {Mon: false, Tue: false, Wed: false, Thu: false, Fri: true, Sat: false, Sun: false},
          },
        ],
      }),
      jsonResponse({writeSuccess: ["timeofuse"]}),
      jsonResponse({}),
    ];

    const result = await service.applyOptimization("auto");

    expect(result.errorMessage).toBeNull();

    const touPosts = requests.filter((request) =>
      request.method === "POST" && request.url.endsWith("/api/config/timeofuse")
    );
    const latestTouPost = touPosts.at(-1);
    expect(JSON.parse(latestTouPost?.body ?? "{}")).toEqual({
      timeofuse: [
        {
          Active: false,
          Power: 4000,
          ScheduleType: "CHARGE_MIN",
          TimeTable: {Start: "22:16", End: "22:22"},
          Weekdays: {Mon: false, Tue: false, Wed: false, Thu: false, Fri: true, Sat: false, Sun: false},
        },
      ],
    });
  });

  it("formats managed time-of-use windows in the configured inverter timezone", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T01:00:30.000Z"));

    const responses = [
      digestChallenge(),
      jsonResponse({}),
      jsonResponse({}),
      jsonResponse({timeofuse: []}),
      jsonResponse({writeSuccess: ["timeofuse"]}),
      jsonResponse({}),
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn((input: URL | string, init?: RequestInit) => {
        requests.push({
          url: input.toString(),
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? init.body : null,
        });
        const next = responses.shift();
        if (!next) {
          throw new Error("Unexpected fetch call");
        }
        return next;
      }),
    );

    const service = createService();
    const result = await service.applyOptimization({
      charge: {untilTimestamp: "2026-03-23T01:10:00.000Z"},
    });

    expect(result.errorMessage).toBeNull();

    const touPost = requests.find((request) =>
      request.method === "POST" && request.url.endsWith("/api/config/timeofuse")
    );
    expect(JSON.parse(touPost?.body ?? "{}")).toEqual({
      timeofuse: [
        {
          Active: true,
          Power: 4000,
          ScheduleType: "CHARGE_MIN",
          TimeTable: {Start: "02:00", End: "02:10"},
          Weekdays: {Mon: true, Tue: false, Wed: false, Thu: false, Fri: false, Sat: false, Sun: false},
        },
      ],
    });
  });
});
