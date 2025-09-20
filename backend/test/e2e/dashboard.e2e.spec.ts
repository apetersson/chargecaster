import "reflect-metadata";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import cors from "@fastify/cors";
import { createTRPCProxyClient, httpBatchLink } from "@trpc/client";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { AppModule } from "../../src/app.module.js";
import { SimulationService, extractForecastFromState } from "../../src/simulation/simulation.service.js";
import type { AppRouter } from "../../src/trpc/trpc.router.js";
import { TrpcRouter } from "../../src/trpc/trpc.router.js";

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
  const rawSample = JSON.parse(readFileSync(sampleDataPath, "utf-8")) as Record<string, unknown>;
  const forecast = extractForecastFromState(rawSample);

  let app: NestFastifyApplication;
  let client: ReturnType<typeof createTRPCProxyClient<AppRouter>>;

  beforeAll(async () => {
    process.env.NODE_ENV = "test";
    const adapter = new FastifyAdapter({ logger: false, maxParamLength: 4096 });
    app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, { logger: false });
    const fastify = app.getHttpAdapter().getInstance();
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
    await (fastify.register as any)(cors, { origin: true });
    const trpcRouter = app.get(TrpcRouter);
    const simulationService = app.get(SimulationService);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
    await (fastify.register as any)(fastifyTRPCPlugin, {
      prefix: "/trpc",
      trpcOptions: {
        router: trpcRouter.router,
        createContext: () => ({ simulationService }),
      },
    });
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
            } else if (typeof input === "object" && input !== null && "url" in input) {
              requestUrl = String((input as { url: string }).url);
            }
            if (!requestUrl) {
              throw new Error("Unsupported request input for tRPC client");
            }

            const headers = requestInit.headers instanceof Headers
              ? Object.fromEntries(requestInit.headers.entries())
              : (requestInit.headers as Record<string, string> | undefined);

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

            const normalizedHeaders = Object.fromEntries(
              Object.entries(response.headers).map(([key, value]) => [
                key,
                Array.isArray(value) ? value.join(",") : String(value),
              ]),
            );

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
    expect(snapshot.trajectory.length).toBe(snapshot.forecast_samples);
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
    expect(history.entries[0]?.timestamp).toBeDefined();

    const trajectory = await client.dashboard.trajectory.query();
    expect(trajectory.generated_at).toEqual(snapshot.timestamp);
    expect(trajectory.points.length).toBe(snapshot.trajectory.length);

    const latest = await client.dashboard.snapshot.query();
    expect(latest.timestamp).toEqual(snapshot.timestamp);
    expect(latest.history.length).toBeGreaterThan(0);
    expect(latest.trajectory.length).toBe(snapshot.trajectory.length);
  });
});
