import "reflect-metadata";

import type { AddressInfo } from "node:net";

import { existsSync } from "node:fs";
import { normalize, relative } from "node:path";
import cors from "@fastify/cors";
import type { FastifyInstance } from "fastify";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { Logger, LogLevel } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import fastifyStatic from "@fastify/static";

import { describeError } from "@chargecaster/domain";
import { AppModule } from "./app.module";
import { ConfigFileService } from "./config/config-file.service";
import { setRuntimeConfig } from "./config/runtime-config";
import type { ConfigDocument } from "./config/schemas";
import { SimulationService } from "./simulation/simulation.service";
import { SimulationSeedService } from "./config/simulation-seed.service";
import { TrpcRouter } from "./trpc/trpc.router";
import { requireFroniusConnectionConfig } from "./fronius/fronius.service";

const isAddressInfo = (value: AddressInfo | string | null): value is AddressInfo =>
  typeof value === "object" && value !== null && "port" in value;

async function bootstrap(): Promise<NestFastifyApplication> {
  const initialConfig = await configureGlobalLogging();
  validateConfigDocument(initialConfig);
  setRuntimeConfig(initialConfig);
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

async function configureGlobalLogging(): Promise<ConfigDocument> {
  const bootstrapLogger = new Logger("bootstrap");
  const configFileService = new ConfigFileService();

  let levels: LogLevel[] = ["fatal", "error", "warn", "log"];
  let normalizedLevel = "info";
  let document: ConfigDocument | null = null;

  try {
    const configPath = configFileService.resolvePath();
    document = await configFileService.loadDocument(configPath);

    const rawLevel = document.logging?.level ?? "info";
    const {levels: resolvedLevels, normalized, fallbackUsed} = resolveLogLevels(rawLevel);
    levels = resolvedLevels;
    normalizedLevel = normalized;
    if (fallbackUsed) {
      bootstrapLogger.warn(`Unknown logging.level value '${String(rawLevel)}'; defaulting to INFO`);
    }
  } catch (error) {
    bootstrapLogger.error(`Failed to load configuration for logging: ${describeError(error)}`);
    throw error instanceof Error ? error : new Error(String(error));
  }

  Logger.overrideLogger(levels);
  bootstrapLogger.log(`Logger minimum level set to ${normalizedLevel.toUpperCase()}`);
  return document;
}

function validateConfigDocument(document: ConfigDocument): void {
  const bootstrapLogger = new Logger("bootstrap");

  try {
    requireFroniusConnectionConfig(document);
  } catch (error) {
    throw new Error(`Fronius configuration invalid: ${describeError(error)}`);
  }

  const evccConfig = document.evcc;
  if (evccConfig && evccConfig.enabled !== false) {
    const baseUrl = typeof evccConfig.base_url === "string" ? evccConfig.base_url.trim() : "";
    if (!baseUrl) {
      throw new Error("EVCC base_url must be provided when evcc.enabled is true.");
    }
  }

  const capacity = document.battery?.capacity_kwh;
  if (typeof capacity !== "number" || !Number.isFinite(capacity) || capacity <= 0) {
    throw new Error("battery.capacity_kwh must be a positive number.");
  }

  const market = document.market_data;
  if (market) {
    const priorities = new Map<number, string[]>();
    const register = (name: string, priority: number | undefined) => {
      if (typeof priority !== "number" || !Number.isFinite(priority)) {
        return;
      }
      if (priority < 0) {
        throw new Error(`market_data.${name}.priority must be a non-negative integer.`);
      }
      const bucket = priorities.get(priority) ?? [];
      bucket.push(name);
      priorities.set(priority, bucket);
    };

    register("awattar", market.awattar?.priority);
    register("entsoe", market.entsoe?.priority);
    register("from_evcc", market.from_evcc?.priority);

    for (const [priority, providers] of priorities.entries()) {
      if (providers.length > 1) {
        throw new Error(`Duplicate market_data priority ${priority} assigned to ${providers.join(", ")}.`);
      }
    }
  }

  bootstrapLogger.verbose("Configuration validation successful.");
}

function resolveLogLevels(level: unknown): { levels: LogLevel[]; normalized: string; fallbackUsed: boolean } {
  const normalizedInput = typeof level === "string" ? level.trim().toLowerCase() : "info";
  const aliasMap: Record<string, string> = {
    log: "info",
    info: "info",
    warning: "warn",
  };
  const canonical = aliasMap[normalizedInput] ?? normalizedInput;

  switch (canonical) {
    case "fatal":
      return {levels: ["fatal"], normalized: "fatal", fallbackUsed: false};
    case "error":
      return {levels: ["fatal", "error"], normalized: "error", fallbackUsed: false};
    case "warn":
      return {levels: ["fatal", "error", "warn"], normalized: "warn", fallbackUsed: false};
    case "info":
      return {levels: ["fatal", "error", "warn", "log"], normalized: "info", fallbackUsed: false};
    case "debug":
      return {levels: ["fatal", "error", "warn", "log", "debug"], normalized: "debug", fallbackUsed: false};
    case "verbose":
      return {levels: ["fatal", "error", "warn", "log", "debug", "verbose"], normalized: "verbose", fallbackUsed: false};
    default:
      return {levels: ["fatal", "error", "warn", "log"], normalized: "info", fallbackUsed: true};
  }
}

if (process.env.NODE_ENV !== "test") {
  void bootstrap();
}

export { bootstrap };
