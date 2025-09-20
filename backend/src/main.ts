import "reflect-metadata";

import type { AddressInfo } from "node:net";

import cors from "@fastify/cors";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";

import { AppModule } from "./app.module.js";
import { SimulationService } from "./simulation/simulation.service.js";
import { TrpcRouter } from "./trpc/trpc.router.js";

const isAddressInfo = (value: AddressInfo | string | null): value is AddressInfo =>
  typeof value === "object" && value !== null && "port" in value;

async function bootstrap(): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({ logger: false, maxParamLength: 4096 });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  const fastify = app.getHttpAdapter().getInstance();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
  await (fastify.register as any)(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
  });

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

  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen(port, host);

  if (process.env.NODE_ENV !== "test") {
    const logger = new Logger("batteryctl");
    const address = fastify.server.address();
    let baseUrl = `http://localhost:${port}`;
    if (isAddressInfo(address)) {
      const resolvedHost = address.address === "::" || address.address === "0.0.0.0" ? "localhost" : address.address;
      baseUrl = `http://${resolvedHost}:${address.port}`;
    } else if (typeof address === "string" && address.length > 0) {
      baseUrl = address;
    }

    logger.log(`API ready at ${baseUrl}`);

    const routesTree = fastify.printRoutes({ includeHooks: false, includeMeta: false, commonPrefix: false });
    if (typeof routesTree === "string" && routesTree.trim().length > 0) {
      logger.log(`Routes:\n${routesTree}`);
    }
  }

  return app;
}

if (process.env.NODE_ENV !== "test") {
  void bootstrap();
}

export { bootstrap };
