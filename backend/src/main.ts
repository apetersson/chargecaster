import "reflect-metadata";

import type { AddressInfo } from "node:net";

import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { normalize, relative } from "node:path";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import fastifyStatic from "@fastify/static";

import { AppModule } from "./app.module";
import { SimulationService } from "./simulation/simulation.service";
import { SimulationSeedService } from "./config/simulation-seed.service";
import { TrpcRouter } from "./trpc/trpc.router";

const isAddressInfo = (value: AddressInfo | string | null): value is AddressInfo =>
  typeof value === "object" && value !== null && "port" in value;

async function bootstrap(): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({logger: false, maxParamLength: 4096});
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  app.useLogger(new Logger("bootstrap"));
  app.flushLogs();

  const fastify = app.getHttpAdapter().getInstance() as unknown as FastifyInstance;
  await fastify.register(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
  });

  const trpcRouter = app.get(TrpcRouter);
  const simulationService = app.get(SimulationService);
  const configSeedService = app.get(SimulationSeedService);
  await fastify.register(fastifyTRPCPlugin, {
    prefix: "/trpc",
    trpcOptions: {
      router: trpcRouter.router,
      createContext: () => ({simulationService}),
    },
  });

  // Optional static serving (replaces nginx in container). Enable when
  // SERVE_STATIC=true and /public exists (container builds) or when explicitly opted in.
  const serveStatic = (process.env.SERVE_STATIC === "true" || process.env.SERVE_STATIC === "1") && existsSync("/public");
  if (serveStatic) {
    const publicRoot = normalize("/public");
    await fastify.register(fastifyStatic, {
      root: publicRoot,
      prefix: "/",
      cacheControl: true,
      wildcard: false,
      setHeaders(res, filePath) {
        const relPath = relative(publicRoot, normalize(filePath)).replace(/\\/g, "/");
        if (relPath.startsWith("assets/")) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    });

    fastify.get("/*", async (req, reply) => {
      if (req.raw.method && req.raw.method !== "GET") {
        return reply.callNotFound();
      }
      const accept = req.headers.accept ?? "";
      if (!accept.includes("text/html") && accept.length > 0) {
        return reply.callNotFound();
      }

      return reply.type("text/html").sendFile("index.html");
    });
  }

  if (process.env.NODE_ENV !== "test") {
    await configSeedService.seedFromConfig();
  }

  const port = Number(process.env.PORT ?? 4000);
  const host = process.env.HOST ?? "0.0.0.0";
  await app.listen(port, host);

  if (process.env.NODE_ENV !== "test") {
    const logger = new Logger("chargecaster");
    const address = fastify.server.address();
    let baseUrl = `http://localhost:${port}`;
    if (isAddressInfo(address)) {
      const resolvedHost = address.address === "::" || address.address === "0.0.0.0" ? "localhost" : address.address;
      baseUrl = `http://${resolvedHost}:${address.port}`;
    } else if (typeof address === "string" && address.length > 0) {
      baseUrl = address;
    }

    logger.log(`API ready at ${baseUrl}`);

    const routesTree = fastify.printRoutes({includeHooks: false, includeMeta: false, commonPrefix: false});
    if (routesTree.trim().length > 0) {
      logger.log(`Routes:\n${routesTree}`);
    }

    const trpcProcedures = trpcRouter.listProcedures();
    if (trpcProcedures.length) {
      const formatted = trpcProcedures
        .map(({path, type}, index) => {
          const prefix = index === trpcProcedures.length - 1 ? "└──" : "├──";
          return `${prefix} ${type.toUpperCase()} /trpc/${path}`;
        })
        .join("\n");
      logger.log(`tRPC procedures:\n${formatted}`);
    }
  }

  return app;
}

if (process.env.NODE_ENV !== "test") {
  void bootstrap();
}

export { bootstrap };
