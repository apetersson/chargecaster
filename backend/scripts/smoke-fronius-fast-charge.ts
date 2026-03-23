import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

import { parseConfigDocument, parseEvccState, type ConfigDocument } from "../src/config/schemas";
import { setRuntimeConfig } from "../src/config/runtime-config";
import { RuntimeConfigService } from "../src/config/runtime-config.service";
import { FroniusService, requireFroniusConnectionConfig, type FroniusConnectionConfig } from "../src/fronius/fronius.service";

const BATTERIES_PATH = "/api/config/batteries";
const TIME_OF_USE_PATH = "/api/config/timeofuse";
const DEFAULT_BEFORE_PROBES = 4;
const DEFAULT_AFTER_PROBES = 8;
const DEFAULT_INTERVAL_SECONDS = 10;
const DEFAULT_SETTLE_SECONDS = 20;

interface CliOptions {
  configPath: string;
  execute: boolean;
  beforeProbes: number;
  afterProbes: number;
  intervalSeconds: number;
  settleSeconds: number;
  targetPercent: number | null;
  keepChanges: boolean;
}

interface ProbeSample {
  timestamp: string;
  source: "fronius-solar-api" | "evcc";
  batteryPowerW: number | null;
  chargingPowerW: number | null;
  gridPowerW: number | null;
  solarPowerW: number | null;
  loadPowerW: number | null;
  batterySocPercent: number | null;
}

interface ProbeSummary {
  samples: ProbeSample[];
  averageChargingPowerW: number | null;
  peakChargingPowerW: number | null;
}

interface BatterySnapshot {
  mode: string | null;
  targetPercent: number | null;
  raw: unknown;
}

interface TimeOfUseSnapshot {
  raw: unknown;
  entries: Record<string, unknown>[];
}

interface FroniusInternals extends FroniusService {
  froniusConfig: FroniusConnectionConfig | null;
  loginFroniusSession(config: FroniusConnectionConfig, batteriesPathHint: string): Promise<void>;
  logoutFroniusSession(config: FroniusConnectionConfig): Promise<void>;
  requestJson(
    method: string,
    url: string,
    credentials: FroniusConnectionConfig,
    payload?: Record<string, unknown> | null,
  ): Promise<unknown>;
  buildBatteriesUrlCandidates(host: string, configuredPath: string): string[];
  buildTimeOfUseUrlCandidates(host: string, configuredPath: string): string[];
  extractCurrentTarget(payload: unknown): number | null;
  extractCurrentMode(payload: unknown): string | null;
}

function parseArgs(argv: string[]): CliOptions {
  let configPath = resolveConfigPath();
  let execute = false;
  let keepChanges = false;
  let beforeProbes = DEFAULT_BEFORE_PROBES;
  let afterProbes = DEFAULT_AFTER_PROBES;
  let intervalSeconds = DEFAULT_INTERVAL_SECONDS;
  let settleSeconds = DEFAULT_SETTLE_SECONDS;
  let targetPercent: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const nextValue = argv[index + 1];
    if (argument === "--config" && nextValue) {
      configPath = resolve(process.cwd(), nextValue);
      index += 1;
      continue;
    }
    if (argument === "--execute") {
      execute = true;
      continue;
    }
    if (argument === "--keep-changes") {
      keepChanges = true;
      continue;
    }
    if (argument === "--before-probes" && nextValue) {
      beforeProbes = parsePositiveInt(nextValue, "--before-probes");
      index += 1;
      continue;
    }
    if (argument === "--after-probes" && nextValue) {
      afterProbes = parsePositiveInt(nextValue, "--after-probes");
      index += 1;
      continue;
    }
    if (argument === "--interval-seconds" && nextValue) {
      intervalSeconds = parsePositiveInt(nextValue, "--interval-seconds");
      index += 1;
      continue;
    }
    if (argument === "--settle-seconds" && nextValue) {
      settleSeconds = parsePositiveInt(nextValue, "--settle-seconds");
      index += 1;
      continue;
    }
    if (argument === "--target-percent" && nextValue) {
      targetPercent = parseBoundedPercent(nextValue);
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      printUsage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return {
    configPath,
    execute,
    beforeProbes,
    afterProbes,
    intervalSeconds,
    settleSeconds,
    targetPercent,
    keepChanges,
  };
}

function printUsage(): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "Usage:",
      "  pnpm --filter chargecaster-backend tsx scripts/smoke-fronius-fast-charge.ts --execute",
      "",
      "Options:",
      "  --config <path>            Config file to use (default: config.local.yaml)",
      "  --before-probes <n>        Number of baseline probes before enabling time-of-use",
      "  --after-probes <n>         Number of probes after enabling time-of-use",
      "  --interval-seconds <n>     Probe interval in seconds",
      "  --settle-seconds <n>       Wait time after each config change before probing",
      "  --target-percent <n>       Manual charge target to use during the test",
      "  --keep-changes             Do not restore original inverter settings at the end",
      "  --execute                  Required to perform live writes",
    ].join("\n"),
  );
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return parsed;
}

function parseBoundedPercent(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new Error("--target-percent must be between 0 and 100.");
  }
  return parsed;
}

function resolveConfigPath(): string {
  const explicit = process.env.CHARGECASTER_CONFIG;
  if (explicit?.trim()) {
    return resolve(process.cwd(), explicit.trim());
  }
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), "config.local.yaml"),
    resolve(process.cwd(), "main-chargecaster/config.local.yaml"),
    resolve(scriptDir, "../../config.local.yaml"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return candidates[0] as string;
}

function loadConfigDocument(path: string): ConfigDocument {
  const raw = readFileSync(path, "utf-8");
  const parsed = YAML.parse(raw);
  return parseConfigDocument(parsed);
}

function buildRuntimeDocument(document: ConfigDocument): ConfigDocument {
  return parseConfigDocument({
    ...document,
    dry_run: false,
  });
}

function buildProbeUrls(host: string): string[] {
  const trimmed = host.endsWith("/") ? host.slice(0, -1) : host;
  const normalized = trimmed.startsWith("http://") || trimmed.startsWith("https://")
    ? trimmed
    : `http://${trimmed}`;
  return [
    `${normalized}/solar_api/v1/GetPowerFlowRealtimeData.fcgi`,
    `${normalized}/solar_api/v1/GetPowerFlowRealtimeData.fcgi?Scope=System`,
  ];
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function fetchJson(url: string, timeoutSeconds: number): Promise<unknown> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), Math.max(1, timeoutSeconds) * 1000);
  try {
    const response = await fetch(url, {signal: controller.signal});
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function extractProbeFromSolarApi(payload: unknown): ProbeSample | null {
  const record = asRecord(payload);
  const body = asRecord(record?.Body);
  const data = asRecord(body?.Data);
  const site = asRecord(data?.Site);
  if (!site) {
    return null;
  }
  const batteryPowerW = asFiniteNumber(site.P_Akku ?? site.P_Battery ?? site.BatteryPower);
  const gridPowerW = asFiniteNumber(site.P_Grid ?? site.GridPower);
  const solarPowerW = asFiniteNumber(site.P_PV ?? site.PvPower ?? site.SolarPower);
  const loadPowerW = asFiniteNumber(site.P_Load ?? site.LoadPower);
  const batterySocPercent = asFiniteNumber(site.rel_Autonomy ?? site.StateOfCharge ?? site.SOC);
  return {
    timestamp: new Date().toISOString(),
    source: "fronius-solar-api",
    batteryPowerW,
    chargingPowerW: batteryPowerW == null ? null : Math.max(0, -batteryPowerW),
    gridPowerW,
    solarPowerW,
    loadPowerW,
    batterySocPercent,
  };
}

function extractProbeFromEvcc(payload: unknown): ProbeSample | null {
  const parsed = parseEvccState(payload);
  const batteryPowerW = (
    parsed.siteDemandPowerW != null &&
    parsed.solarPowerW != null &&
    parsed.gridPowerW != null
  )
    ? parsed.siteDemandPowerW - parsed.solarPowerW - parsed.gridPowerW
    : null;
  if (
    batteryPowerW == null &&
    parsed.gridPowerW == null &&
    parsed.solarPowerW == null &&
    parsed.siteDemandPowerW == null
  ) {
    return null;
  }
  return {
    timestamp: new Date().toISOString(),
    source: "evcc",
    batteryPowerW,
    chargingPowerW: batteryPowerW == null ? null : Math.max(0, -batteryPowerW),
    gridPowerW: parsed.gridPowerW,
    solarPowerW: parsed.solarPowerW,
    loadPowerW: parsed.siteDemandPowerW,
    batterySocPercent: parsed.batterySoc,
  };
}

async function probeLivePower(document: ConfigDocument, timeoutSeconds: number): Promise<ProbeSample> {
  const froniusConfig = requireFroniusConnectionConfig(document);
  if (froniusConfig) {
    for (const url of buildProbeUrls(froniusConfig.host)) {
      try {
        const payload = await fetchJson(url, timeoutSeconds);
        const sample = extractProbeFromSolarApi(payload);
        if (sample) {
          return sample;
        }
      } catch {
        // Try the next probe source.
      }
    }
  }

  const evccBase = document.evcc?.base_url?.trim();
  if (document.evcc?.enabled && evccBase) {
    const payload = await fetchJson(new URL("/api/state", evccBase).toString(), timeoutSeconds);
    const sample = extractProbeFromEvcc(payload);
    if (sample) {
      return sample;
    }
  }

  throw new Error("Unable to probe live battery power from Fronius Solar API or EVCC.");
}

function summarizeSamples(samples: ProbeSample[]): ProbeSummary {
  const chargingValues = samples
    .map((sample) => sample.chargingPowerW)
    .filter((value): value is number => value != null && Number.isFinite(value));
  if (!chargingValues.length) {
    return {
      samples,
      averageChargingPowerW: null,
      peakChargingPowerW: null,
    };
  }
  const averageChargingPowerW = chargingValues.reduce((sum, value) => sum + value, 0) / chargingValues.length;
  const peakChargingPowerW = chargingValues.reduce((peak, value) => Math.max(peak, value), 0);
  return {
    samples,
    averageChargingPowerW,
    peakChargingPowerW,
  };
}

async function collectProbeSeries(
  document: ConfigDocument,
  count: number,
  intervalSeconds: number,
  timeoutSeconds: number,
  label: string,
): Promise<ProbeSummary> {
  const samples: ProbeSample[] = [];
  for (let index = 0; index < count; index += 1) {
    const sample = await probeLivePower(document, timeoutSeconds);
    samples.push(sample);
    // eslint-disable-next-line no-console
    console.log(
      `[${label}] ${sample.timestamp} source=${sample.source} battery=${formatWatts(sample.batteryPowerW)} charging=${formatWatts(sample.chargingPowerW)} grid=${formatWatts(sample.gridPowerW)} solar=${formatWatts(sample.solarPowerW)} load=${formatWatts(sample.loadPowerW)} soc=${formatPercent(sample.batterySocPercent)}`,
    );
    if (index < count - 1) {
      await sleep(intervalSeconds * 1000);
    }
  }
  return summarizeSamples(samples);
}

function formatWatts(value: number | null): string {
  return value == null ? "n/a" : `${Math.round(value)}W`;
}

function formatPercent(value: number | null): string {
  return value == null ? "n/a" : `${value.toFixed(1)}%`;
}

async function requestWithFallback(
  service: FroniusInternals,
  config: FroniusConnectionConfig,
  urls: string[],
  method: "GET" | "POST",
  payload: Record<string, unknown> | null = null,
): Promise<{payload: unknown; url: string}> {
  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      const response = await service.requestJson(method, url, config, payload);
      return {payload: response, url};
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!lastError.message.includes("HTTP 404")) {
        throw lastError;
      }
    }
  }
  throw lastError ?? new Error(`Unable to ${method} Fronius configuration via ${urls.join(", ")}`);
}

async function readBatterySnapshot(
  service: FroniusInternals,
  config: FroniusConnectionConfig,
): Promise<BatterySnapshot> {
  const {payload} = await requestWithFallback(
    service,
    config,
    service.buildBatteriesUrlCandidates(config.host, BATTERIES_PATH),
    "GET",
  );
  return {
    raw: cloneJson(payload),
    mode: service.extractCurrentMode(payload),
    targetPercent: service.extractCurrentTarget(payload),
  };
}

async function writeBatteryTarget(
  service: FroniusInternals,
  config: FroniusConnectionConfig,
  targetPercent: number,
): Promise<void> {
  await requestWithFallback(
    service,
    config,
    service.buildBatteriesUrlCandidates(config.host, BATTERIES_PATH),
    "POST",
    {
      BAT_M0_SOC_MIN: Math.round(targetPercent),
      BAT_M0_SOC_MODE: "manual",
    },
  );
}

async function restoreBatterySnapshot(
  service: FroniusInternals,
  config: FroniusConnectionConfig,
  snapshot: BatterySnapshot,
): Promise<void> {
  if (snapshot.mode === "auto") {
    await requestWithFallback(
      service,
      config,
      service.buildBatteriesUrlCandidates(config.host, BATTERIES_PATH),
      "POST",
      {
        BAT_M0_SOC_MIN: snapshot.targetPercent == null ? 5 : Math.round(snapshot.targetPercent),
        BAT_M0_SOC_MODE: "auto",
      },
    );
    return;
  }
  if ((snapshot.mode === "charge" || snapshot.mode === "manual" || snapshot.mode === "hold") && snapshot.targetPercent != null) {
    await requestWithFallback(
      service,
      config,
      service.buildBatteriesUrlCandidates(config.host, BATTERIES_PATH),
      "POST",
      {
        BAT_M0_SOC_MIN: Math.round(snapshot.targetPercent),
        BAT_M0_SOC_MODE: "manual",
      },
    );
    return;
  }
  // eslint-disable-next-line no-console
  console.warn("Unable to infer original battery target cleanly; leaving battery mode untouched.");
}

async function readTimeOfUseSnapshot(
  service: FroniusInternals,
  config: FroniusConnectionConfig,
): Promise<TimeOfUseSnapshot> {
  const {payload} = await requestWithFallback(
    service,
    config,
    service.buildTimeOfUseUrlCandidates(config.host, TIME_OF_USE_PATH),
    "GET",
  );
  const record = asRecord(payload);
  const entries = Array.isArray(record?.timeofuse)
    ? cloneJson(record?.timeofuse as Record<string, unknown>[])
    : [];
  return {
    raw: cloneJson(payload),
    entries,
  };
}

async function writeTimeOfUseEntries(
  service: FroniusInternals,
  config: FroniusConnectionConfig,
  entries: Record<string, unknown>[],
): Promise<void> {
  await requestWithFallback(
    service,
    config,
    service.buildTimeOfUseUrlCandidates(config.host, TIME_OF_USE_PATH),
    "POST",
    {timeofuse: entries},
  );
}

function disableChargeMinEntries(entries: Record<string, unknown>[]): Record<string, unknown>[] {
  return entries.map((entry) => {
    const scheduleType = entry.ScheduleType;
    if (scheduleType !== "CHARGE_MIN") {
      return cloneJson(entry);
    }
    return {
      ...cloneJson(entry),
      Active: false,
    };
  });
}

function buildPreview(
  options: CliOptions,
  document: ConfigDocument,
  targetPercent: number,
): string {
  const froniusConfig = requireFroniusConnectionConfig(document);
  const power = document.battery?.max_charge_power_w ?? null;
  return [
    "Fronius fast-charge smoke test preview",
    `config: ${options.configPath}`,
    `host: ${froniusConfig?.host ?? "n/a"}`,
    `dry_run in file: ${document.dry_run}`,
    `manual target: ${targetPercent}%`,
    `time-of-use charge floor power: ${power ?? "n/a"}W`,
    `before probes: ${options.beforeProbes}`,
    `after probes: ${options.afterProbes}`,
    `probe interval: ${options.intervalSeconds}s`,
    `settle time: ${options.settleSeconds}s`,
    "",
    "This script will:",
    "1. snapshot the current battery target and time-of-use config",
    "2. force manual charging without active CHARGE_MIN entries and probe baseline power",
    "3. enable the permanent managed CHARGE_MIN entry and probe again",
    "4. restore the original inverter config unless --keep-changes is set",
    "",
    "Run again with --execute to perform live writes.",
  ].join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const document = loadConfigDocument(options.configPath);
  const targetPercent = options.targetPercent ?? Math.round(document.battery?.max_charge_soc_percent ?? 100);
  const timeoutSeconds = Math.max(3, document.fronius?.timeout_s ?? 6);

  // eslint-disable-next-line no-console
  console.log(buildPreview(options, document, targetPercent));
  if (!options.execute) {
    return;
  }

  if (!document.fronius?.enabled) {
    throw new Error("Fronius must be enabled in the selected config.");
  }
  if (document.battery?.max_charge_power_w == null || document.battery.max_charge_power_w <= 0) {
    throw new Error("battery.max_charge_power_w must be configured to run the smoke test.");
  }

  const runtimeDocument = buildRuntimeDocument(document);
  setRuntimeConfig(runtimeDocument);
  const runtimeConfigService = new RuntimeConfigService();
  const froniusService = new FroniusService(runtimeConfigService) as FroniusInternals;
  const froniusConfig = requireFroniusConnectionConfig(runtimeDocument);
  if (!froniusConfig) {
    throw new Error("Fronius connection config is missing.");
  }

  let batterySnapshot: BatterySnapshot | null = null;
  let timeOfUseSnapshot: TimeOfUseSnapshot | null = null;
  let restored = false;

  const restore = async (): Promise<void> => {
    if (restored || options.keepChanges) {
      return;
    }
    restored = true;
    if (timeOfUseSnapshot) {
      await writeTimeOfUseEntries(froniusService, froniusConfig, timeOfUseSnapshot.entries);
    }
    if (batterySnapshot) {
      await restoreBatterySnapshot(froniusService, froniusConfig, batterySnapshot);
    }
  };

  const signalHandler = async (signal: NodeJS.Signals): Promise<void> => {
    // eslint-disable-next-line no-console
    console.warn(`Received ${signal}; restoring inverter state before exit.`);
    try {
      await restore();
    } finally {
      process.exit(1);
    }
  };

  process.once("SIGINT", () => {
    void signalHandler("SIGINT");
  });
  process.once("SIGTERM", () => {
    void signalHandler("SIGTERM");
  });

  try {
    batterySnapshot = await readBatterySnapshot(froniusService, froniusConfig);
    timeOfUseSnapshot = await readTimeOfUseSnapshot(froniusService, froniusConfig);

    // eslint-disable-next-line no-console
    console.log(
      `Original inverter state: mode=${batterySnapshot.mode ?? "n/a"} target=${batterySnapshot.targetPercent ?? "n/a"}% timeofuse_entries=${timeOfUseSnapshot.entries.length}`,
    );

    await writeBatteryTarget(froniusService, froniusConfig, targetPercent);
    await writeTimeOfUseEntries(
      froniusService,
      froniusConfig,
      disableChargeMinEntries(timeOfUseSnapshot.entries),
    );

    // eslint-disable-next-line no-console
    console.log(`Waiting ${options.settleSeconds}s for baseline charging behaviour...`);
    await sleep(options.settleSeconds * 1000);
    const beforeSummary = await collectProbeSeries(
      runtimeDocument,
      options.beforeProbes,
      options.intervalSeconds,
      timeoutSeconds,
      "before",
    );

    // eslint-disable-next-line no-console
    console.log("Applying accelerated Fronius time-of-use charging strategy...");
    const applyResult = await froniusService.applyOptimization("charge");
    if (applyResult.errorMessage) {
      throw new Error(`Fronius applyOptimization returned an error: ${applyResult.errorMessage}`);
    }

    // eslint-disable-next-line no-console
    console.log(`Waiting ${options.settleSeconds}s for accelerated charging behaviour...`);
    await sleep(options.settleSeconds * 1000);
    const afterSummary = await collectProbeSeries(
      runtimeDocument,
      options.afterProbes,
      options.intervalSeconds,
      timeoutSeconds,
      "after",
    );

    // eslint-disable-next-line no-console
    console.log("");
    // eslint-disable-next-line no-console
    console.log("Summary");
    // eslint-disable-next-line no-console
    console.log(`before avg charging: ${formatWatts(beforeSummary.averageChargingPowerW)}`);
    // eslint-disable-next-line no-console
    console.log(`before peak charging: ${formatWatts(beforeSummary.peakChargingPowerW)}`);
    // eslint-disable-next-line no-console
    console.log(`after avg charging:  ${formatWatts(afterSummary.averageChargingPowerW)}`);
    // eslint-disable-next-line no-console
    console.log(`after peak charging: ${formatWatts(afterSummary.peakChargingPowerW)}`);

    const reachedFastCharge = (afterSummary.peakChargingPowerW ?? 0) >= 3500;
    // eslint-disable-next-line no-console
    console.log(`fast-charge threshold reached: ${reachedFastCharge ? "YES" : "NO"}`);
    if (reachedFastCharge) {
      // eslint-disable-next-line no-console
      console.log("Observed post-change charging power reached the expected ~4000W class.");
    }
  } finally {
    await restore();
    await froniusService.logoutFroniusSession(froniusConfig);
    if (!options.keepChanges) {
      // eslint-disable-next-line no-console
      console.log("Original inverter settings restored.");
    }
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`Smoke test failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
