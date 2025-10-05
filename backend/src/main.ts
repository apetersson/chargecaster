import "reflect-metadata";

import type { AddressInfo } from "node:net";

import cors from "@fastify/cors";
import { existsSync, createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize } from "node:path";
import { join } from "node:path";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";

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

  const fastify = app.getHttpAdapter().getInstance();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
  await (fastify.register as any)(cors, {
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
  });

  const trpcRouter = app.get(TrpcRouter);
  const simulationService = app.get(SimulationService);
  const configSeedService = app.get(SimulationSeedService);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
  await (fastify.register as any)(fastifyTRPCPlugin, {
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
    const publicRoot = "/public";
    const contentType = (p: string): string => {
      if (p.endsWith(".js")) return "application/javascript";
      if (p.endsWith(".css")) return "text/css";
      if (p.endsWith(".svg")) return "image/svg+xml";
      if (p.endsWith(".png")) return "image/png";
      if (p.endsWith(".ico")) return "image/x-icon";
      if (p.endsWith(".map")) return "application/json";
      if (p.endsWith(".html")) return "text/html";
      return "application/octet-stream";
    };

    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    fastify.get("/*", async (req, reply) => {
      const url = req.raw.url ?? "/";
      let target = url.startsWith("/assets/") ? url : "/index.html";
      const fullPath = normalize(join(publicRoot, target));
      if (!fullPath.startsWith(publicRoot)) {
        return reply.code(403).send("Forbidden");
      }
      try {
        await stat(fullPath);
        reply.header("Cache-Control", target.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache");
        reply.type(contentType(fullPath));
        return reply.send(createReadStream(fullPath));
      } catch {
        // Fallback to SPA index
        const indexPath = join(publicRoot, "index.html");
        reply.type("text/html");
        return reply.send(createReadStream(indexPath));
      }
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
