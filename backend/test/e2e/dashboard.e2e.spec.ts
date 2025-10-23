import "reflect-metadata";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import type { FastifyCorsOptions } from "@fastify/cors";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import type { FastifyTRPCPluginOptions } from "@trpc/server/adapters/fastify";
import { Test } from "@nestjs/testing";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { AppModule } from "../../src/app.module";
import { SimulationService, extractForecastFromState } from "../../src/simulation/simulation.service";
import type { AppRouter } from "../../src/trpc/trpc.router";
import { TrpcRouter } from "../../src/trpc/trpc.router";
import { setRuntimeConfig } from "../../src/config/runtime-config";
import type { ConfigDocument } from "../../src/config/schemas";
const config = {
  battery: {
    capacity_kwh: 12,
    max_charge_power_w: 500,
    auto_mode_floor_soc: 5,
  },
  price: {
    grid_fee_eur_per_kwh: 0.02,
  },
  logic: {
    interval_seconds: 300,
    min_hold_minutes: 20,
    house_load_w: 1200,
  },
};

describe("dashboard tRPC", () => {
  const sampleDataPath = join(process.cwd(), "fixtures", "sample_data.json");
  const rawSample: unknown = JSON.parse(readFileSync(sampleDataPath, "utf-8"));
  const forecast = extractForecastFromState(rawSample);

  let app: NestFastifyApplication;
  let client: ReturnType<typeof createTRPCProxyClient<AppRouter>>;
  let originalStoragePath: string | undefined;
  let testDbDir: string;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const testDbPath = join(process.cwd(), "..", "data", "test_db", "backend-e2e.sqlite");
    testDbDir = join(process.cwd(), "..", "data", "test_db");
    if (existsSync(testDbDir)) {
      throw new Error(`Refusing to run dashboard e2e: test DB folder already exists at ${testDbDir}`);
    }
    originalStoragePath = process.env.CHARGECASTER_STORAGE_PATH;
    process.env.CHARGECASTER_STORAGE_PATH = testDbPath;
    const runtimeConfig: ConfigDocument = {
      dry_run: true,
      fronius: {
        enabled: false,
      },
      battery: {
        capacity_kwh: 12,
        max_charge_power_w: 500,
        auto_mode_floor_soc: 5,
      },
      price: {
        grid_fee_eur_per_kwh: 0.02,
      },
      logic: {
        interval_seconds: 300,
        min_hold_minutes: 20,
        house_load_w: 1200,
        allow_battery_export: true,
      },
      logging: {
        level: "info",
      },
    };
    setRuntimeConfig(runtimeConfig);

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .compile();

    const adapter = new FastifyAdapter({ logger: false, maxParamLength: 4096 });
    app = moduleRef.createNestApplication<NestFastifyApplication>(adapter);
    const fastify = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
    await fastify.register(cors, { origin: true } satisfies FastifyCorsOptions);
    const trpcRouter = app.get(TrpcRouter);
    const simulationService = app.get(SimulationService);
    await fastify.register(fastifyTRPCPlugin, {
      prefix: "/trpc",
      trpcOptions: {
        router: trpcRouter.router,
        createContext: () => ({ simulationService }),
      },
    } satisfies FastifyTRPCPluginOptions<AppRouter>);
    await app.init();

    client = createTRPCProxyClient<AppRouter>({
      links: [
        httpBatchLink({
          url: "/trpc",
          fetch: async (input, init) => {
            const requestInit = init ?? {};
            let requestUrl: string | undefined;
            if (typeof input === "string") {
              requestUrl = input;
            } else if (input instanceof URL) {
              requestUrl = input.toString();
            } else if (input instanceof Request) {
              requestUrl = input.url;
            }
            if (!requestUrl) {
              throw new Error("Unsupported request input for tRPC client");
            }

            let headers: Record<string, string> | undefined;
            if (requestInit.headers instanceof Headers) {
              const headerPairs: [string, string][] = [];
              requestInit.headers.forEach((value, key) => {
                headerPairs.push([key, value]);
              });
              headers = Object.fromEntries(headerPairs);
            } else {
              headers = requestInit.headers as Record<string, string> | undefined;
            }

            const method = (requestInit.method ?? "POST") as
              | "GET"
              | "POST"
              | "PUT"
              | "DELETE"
              | "PATCH"
              | "OPTIONS";

            const payload = requestInit.body as string | Buffer | Uint8Array | undefined;

            const response = await fastify.inject({
              method,
              url: requestUrl,
              payload,
              headers,
            });

            const headerEntries: [string, string][] = [];
            const headerRecord = response.headers as Record<string, string | string[]>;
            for (const key in headerRecord) {
              if (!Object.hasOwn(headerRecord, key)) {
                continue;
              }
              const rawValue = headerRecord[key];
              const normalized = Array.isArray(rawValue) ? rawValue.join(",") : String(rawValue);
              headerEntries.push([key, normalized]);
            }

            const normalizedHeaders = Object.fromEntries(headerEntries);

            return new Response(response.payload, {
              status: response.statusCode,
              headers: normalizedHeaders,
            });
          },
        }),
      ],
    });
  });

  afterAll(async () => {
    await app.close();
    rmSync(testDbDir, { recursive: true, force: true });
    if (originalStoragePath === undefined) {
      delete process.env.CHARGECASTER_STORAGE_PATH;
    } else {
      process.env.CHARGECASTER_STORAGE_PATH = originalStoragePath;
    }
  });

  test("runs simulation and stores snapshot", async () => {
    const liveState = {
      battery_soc: Number((rawSample as { batterySoc?: unknown }).batterySoc ?? 40),
    };

    const snapshot = await client.dashboard.runSimulation.mutate({
      config,
      liveState,
      forecast,
    });

    expect(snapshot.forecast_samples).toBeGreaterThan(0);
    expect(Array.isArray(snapshot.oracle_entries)).toBe(true);
    expect(snapshot.oracle_entries.length).toBe(snapshot.forecast_samples);
    expect(snapshot.recommended_soc_percent).toBeGreaterThanOrEqual(0);
    expect(snapshot.recommended_soc_percent).toBeLessThanOrEqual(100);
    expect(snapshot.current_soc_percent).toBeGreaterThanOrEqual(0);
    expect(snapshot.next_step_soc_percent).toBeGreaterThanOrEqual(0);
    expect(snapshot.projected_cost_eur).not.toBeNull();
    expect(snapshot.history.length).toBeGreaterThan(0);

    const summary = await client.dashboard.summary.query();
    expect(summary.timestamp).toEqual(snapshot.timestamp);
    expect(summary.recommended_final_soc_percent).toEqual(snapshot.recommended_final_soc_percent);

    const history = await client.dashboard.history.query({ limit: 24 });
    expect(history.generated_at).toEqual(snapshot.timestamp);
    expect(history.entries.length).toBeGreaterThan(0);
    if (history.entries.length === 0) {
      throw new Error("History entries should not be empty");
    }
    expect(history.entries[0].timestamp).toBeDefined();

    const forecastResponse = await client.dashboard.forecast.query();
    expect(forecastResponse.generated_at).toEqual(snapshot.timestamp);
    expect(Array.isArray(forecastResponse.eras)).toBe(true);
    expect(forecastResponse.eras.length).toBeGreaterThan(0);

    const oracle = await client.dashboard.oracle.query();
    expect(oracle.generated_at).toEqual(snapshot.timestamp);
    expect(Array.isArray(oracle.entries)).toBe(true);
    expect(oracle.entries.length).toBeGreaterThan(0);

    const latest = await client.dashboard.snapshot.query();
    expect(latest.timestamp).toEqual(snapshot.timestamp);
    expect(latest.history.length).toBeGreaterThan(0);
    expect(Array.isArray(latest.oracle_entries)).toBe(true);
    expect(latest.oracle_entries.length).toBe(snapshot.oracle_entries.length);
  });
});
