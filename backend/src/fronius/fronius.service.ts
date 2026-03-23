import { createHash, randomBytes } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";

import { describeError, Percentage, Power } from "@chargecaster/domain";
import type { ConfigDocument } from "../config/schemas";
import { RuntimeConfigService } from "../config/runtime-config.service";

export interface FroniusConnectionConfig {
  host: string;
  user: string;
  password: string;
  timeoutSeconds: number;
  verifyTls: boolean;
}

const DIGEST_PREFIX = "digest";

const AUTH_ERROR_SUMMARY_MESSAGE = "Unable to control battery because of authentication problem.";

const TARGET_TOLERANCE_PERCENT = 0.5;
const MIN_TIME_OF_USE_WINDOW_MINUTES = 2;
const MAX_TIME_OF_USE_WINDOW_MINUTES = 15;
const BATTERIES_PATH = "/api/config/batteries";
const TIME_OF_USE_PATH = "/api/config/timeofuse";

export interface FroniusApplyResult {
  errorMessage: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type FroniusMode = "charge" | "auto" | "hold";

export type OptimisationCommand =
  | {charge: {untilTimestamp?: string | null}}
  | "charge"
  | "auto"
  | {auto: {floorSocPercent?: number | null}}
  | {hold: {minSocPercent: number; observedSocPercent?: number | null; floorSocPercent?: number | null}};

interface NormalisedStrategy {
  mode: FroniusMode;
  manualTarget: Percentage | null;
  observedSocPercent: number | null;
  floorTarget: Percentage | null;
  chargeUntil: Date | null;
}

interface DigestSession {
  nonce: string;
  realm: string;
  qop: string;
  ha1: string;
  nc: number;
}

interface FroniusWeekdays {
  Mon: boolean;
  Tue: boolean;
  Wed: boolean;
  Thu: boolean;
  Fri: boolean;
  Sat: boolean;
  Sun: boolean;
}

interface FroniusTimeTable {
  Start: string;
  End: string;
}

interface FroniusTimeOfUseEntry {
  Active: boolean;
  Power: Power;
  ScheduleType: "CHARGE_MIN";
  TimeTable: FroniusTimeTable;
  Weekdays: FroniusWeekdays;
}

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  weekday: keyof FroniusWeekdays;
  hour: string;
  minute: string;
}

@Injectable()

export class FroniusService {
  private readonly logger = new Logger(FroniusService.name);
  private readonly froniusConfig: FroniusConnectionConfig | null;
  private readonly dryRunEnabled: boolean;
  private readonly froniusDisabled: boolean;
  private readonly autoModeFloorOverride: Percentage | null;
  private readonly maxChargeLimit: Percentage | null;
  private readonly chargeFloorPower: Power | null;
  private readonly chargeFloorWindowMinutes: number;
  private readonly timeZone: string | null;
  private lastAppliedTarget: Percentage | null = null;
  private lastAppliedMode: FroniusMode | null = null;
  private workingBatteriesPath: string | null = null;
  private workingCommandsPrefix: string | null = null;
  private workingTimeOfUsePath: string | null = null;
  private lastManagedTimeOfUseEntry: FroniusTimeOfUseEntry | null = null;
  private digestSession: DigestSession | null = null;

  constructor(@Inject(RuntimeConfigService) private readonly configState: RuntimeConfigService) {
    const document = this.configState.getDocumentRef();
    this.dryRunEnabled = document.dry_run;
    this.froniusDisabled = document.fronius?.enabled === false;
    this.autoModeFloorOverride = this.parsePercentage(document.battery?.auto_mode_floor_soc ?? null);
    this.maxChargeLimit = this.parsePercentage(document.battery?.max_charge_soc_percent ?? null);
    this.chargeFloorPower = this.parsePositivePower(document.battery?.max_charge_power_w ?? null);
    this.timeZone = this.parseTimeZone(document.location?.timezone ?? null);
    const intervalSeconds = this.parsePositiveNumber(document.logic?.interval_seconds ?? null) ?? 300;
    this.chargeFloorWindowMinutes = Math.min(
      MAX_TIME_OF_USE_WINDOW_MINUTES,
      Math.max(MIN_TIME_OF_USE_WINDOW_MINUTES, Math.ceil(intervalSeconds / 60) + 1),
    );
    let froniusConfig: FroniusConnectionConfig | null = null;
    try {
      froniusConfig = requireFroniusConnectionConfig(document);
    } catch (error) {
      this.logger.error(`Fronius configuration invalid: ${describeError(error)}`);
      throw error instanceof Error ? error : new Error(String(error));
    }

    if (froniusConfig !== null) {
      this.logger.log(`Fronius integration configured for ${froniusConfig.host}`);
    } else {
      this.logger.log("Fronius integration disabled by configuration.");
    }
    this.froniusConfig = froniusConfig;
  }

  async applyOptimization(strategyInput: OptimisationCommand): Promise<FroniusApplyResult> {
    if (this.dryRunEnabled) {
      this.logger.log("Dry run enabled; skipping Fronius optimization apply.");
      return {errorMessage: null};
    }
    if (this.froniusDisabled) {
      this.logger.verbose("Fronius integration disabled in config; skipping optimisation.");
      return {errorMessage: null};
    }
    if (this.froniusConfig === null) {
      this.logger.verbose("Fronius configuration missing; skipping optimisation.");
      return {errorMessage: null};
    }
    const froniusConfig = this.froniusConfig;
    const strategy = this.normaliseStrategy(strategyInput);
    const desiredMode = strategy.mode;

    try {
      const configuredPath = this.workingBatteriesPath ?? BATTERIES_PATH;
      const urlCandidates = this.buildBatteriesUrlCandidates(froniusConfig.host, configuredPath);
      this.logger.log(
        `Preparing to apply Fronius mode ${desiredMode.toUpperCase()} via ${urlCandidates[0]}`,
      );
      const payload = this.buildPayload(strategy);
      if (!payload) {
        this.logger.warn("Unable to construct Fronius payload; skipping update.");
        return {errorMessage: null};
      }

      const targetLabel = payload.target ? `${payload.target.percent.toFixed(1)}%` : "n/a";
      const shouldApplyBatteryUpdate = !this.shouldSkipBatteryUpdate(strategy);
      if (shouldApplyBatteryUpdate) {
        this.logger.verbose(`Fronius payload: ${JSON.stringify(payload.body)}`);
        let lastError: Error | null = null;
        for (const [index, url] of urlCandidates.entries()) {
          const pathHint = new URL(url).pathname;
          await this.loginFroniusSession(froniusConfig, pathHint);
          this.logger.log(
            `Issuing Fronius command (mode=${desiredMode}, target=${targetLabel}) to ${url}`,
          );
          try {
            await this.requestJson("POST", url, froniusConfig, payload.body);
            this.workingBatteriesPath = new URL(url).pathname;
            this.workingCommandsPrefix = this.extractApiPrefix(this.workingBatteriesPath);
            if (index > 0) {
              this.logger.warn(
                `Fronius accepted fallback batteries endpoint ${this.workingBatteriesPath}; reusing it for this process.`,
              );
            }
            lastError = null;
            break;
          } catch (error: unknown) {
            lastError = error instanceof Error ? error : new Error(String(error));
            const canTryFallback = index < urlCandidates.length - 1;
            if (!canTryFallback || !this.isHttp404(error)) {
              throw error;
            }
            this.logger.warn(`Fronius endpoint ${url} returned 404; trying fallback path.`);
          }
        }
        if (lastError) {
          throw lastError;
        }
      }
      else {
        this.logger.log(`Fronius already aligned with ${desiredMode} strategy; skipping battery update.`);
      }
      await this.syncChargeFloorTimeOfUse(strategy, froniusConfig);
      this.lastAppliedMode = desiredMode;
      this.lastAppliedTarget = payload.target;
      if (desiredMode === "hold" && payload.target && strategy.observedSocPercent != null) {
        const delta = Math.abs(strategy.observedSocPercent - payload.target.percent);
        if (delta > 1) {
          this.logger.warn(
            `Observed SoC ${strategy.observedSocPercent.toFixed(1)}% differs from hold target ${payload.target.percent.toFixed(1)}% by ${delta.toFixed(2)} percentage points.`,
          );
        } else {
          this.logger.verbose(
            `Hold target ${payload.target.percent.toFixed(1)}% aligns with observed SoC ${strategy.observedSocPercent.toFixed(1)}% (Δ=${delta.toFixed(2)}%).`,
          );
        }
      }
      this.logger.log("Fronius command applied successfully.");
      return {errorMessage: null};
    } catch (error: unknown) {
      this.logger.warn(`Fronius update failed: ${describeError(error)}`);
      return {errorMessage: this.normaliseSummaryError(error)};
    } finally {
      await this.logoutFroniusSession(froniusConfig);
    }
  }

  private normaliseStrategy(input: OptimisationCommand): NormalisedStrategy {
    if (input === "charge") {
      return {mode: "charge", manualTarget: null, observedSocPercent: null, floorTarget: null, chargeUntil: null};
    }
    if (input === "auto") {
      return {mode: "auto", manualTarget: null, observedSocPercent: null, floorTarget: null, chargeUntil: null};
    }
    if ("charge" in input) {
      return {
        mode: "charge",
        manualTarget: null,
        observedSocPercent: null,
        floorTarget: null,
        chargeUntil: this.parseTimestamp(input.charge.untilTimestamp),
      };
    }
    if ("hold" in input) {
      const holdConfig = input.hold;
      const manualTarget = this.parsePercentage(holdConfig.minSocPercent);
      if (!manualTarget) {
        throw new Error("Hold strategy requires a finite minSoC percentage.");
      }
      const floorTarget = this.parsePercentage(holdConfig.floorSocPercent ?? holdConfig.minSocPercent);
      const observedSocPercent = this.normaliseObservedSoc(holdConfig.observedSocPercent);
      return {
        mode: "hold",
        manualTarget,
        observedSocPercent,
        floorTarget,
        chargeUntil: null,
      };
    }
    if ("auto" in input) {
      const autoConfig = input.auto;
      const floorTarget = this.parsePercentage(autoConfig.floorSocPercent ?? null);
      return {mode: "auto", manualTarget: null, observedSocPercent: null, floorTarget, chargeUntil: null};
    }
    throw new Error("Unsupported Fronius optimisation command.");
  }

  private normaliseObservedSoc(value: number | null | undefined): number | null {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return null;
    }
    return Math.min(Math.max(value, 0), 100);
  }

  private parseTimestamp(value: string | null | undefined): Date | null {
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      return null;
    }
    return parsed;
  }

  private shouldSkipBatteryUpdate(strategy: NormalisedStrategy): boolean {
    if (this.lastAppliedMode !== strategy.mode) {
      return false;
    }
    if (strategy.mode === "hold") {
      if (!strategy.manualTarget || !this.lastAppliedTarget) {
        return false;
      }
      return Math.abs(this.lastAppliedTarget.percent - strategy.manualTarget.percent) <= TARGET_TOLERANCE_PERCENT;
    }
    if (strategy.mode === "auto") {
      if (!strategy.floorTarget || !this.lastAppliedTarget) {
        return false;
      }
      return Math.abs(this.lastAppliedTarget.percent - strategy.floorTarget.percent) <= TARGET_TOLERANCE_PERCENT;
    }
    return true;
  }

  private async syncChargeFloorTimeOfUse(
    strategy: NormalisedStrategy,
    config: FroniusConnectionConfig,
  ): Promise<void> {
    const managedPower = this.resolveChargeFloorPower();
    if (managedPower == null) {
      return;
    }

    const {entries: existingEntries, path: activePath} = await this.readTimeOfUseEntries(config);
    const existingManagedEntry = this.findExistingManagedTimeOfUseEntry(existingEntries, managedPower);
    const preservedEntries = existingManagedEntry
      ? existingEntries.filter((entry) => entry !== existingManagedEntry)
      : existingEntries;
    const desiredManagedEntry = this.buildManagedChargeFloorEntry(
      managedPower,
      strategy.mode === "charge",
      strategy.chargeUntil,
    );
    const desiredEntries = [...preservedEntries, desiredManagedEntry];

    if (this.timeOfUseEntriesEqual(existingEntries, desiredEntries)) {
      this.lastManagedTimeOfUseEntry = desiredManagedEntry;
      this.logger.verbose("Fronius time-of-use schedule already aligned; skipping update.");
      return;
    }

    await this.writeTimeOfUseEntries(config, activePath, desiredEntries);
    this.lastManagedTimeOfUseEntry = desiredManagedEntry;
  }

  private normaliseSummaryError(error: unknown): string | null {
    if (!error) {
      return null;
    }
    const message = describeError(error).toLowerCase();
    if (!message) {
      return null;
    }
    if (message.includes("401") || message.includes("unauthorized") || message.includes("unauthorised")) {
      return AUTH_ERROR_SUMMARY_MESSAGE;
    }
    return null;
  }

  private extractCurrentTarget(payload: unknown): number | null {
    if (!isRecord(payload)) {
      return null;
    }
    const record = payload;
    const direct = record.BAT_M0_SOC_MIN ?? record.bat_m0_soc_min;
    if (typeof direct === "number" && Number.isFinite(direct)) {
      return direct;
    }
    const primary = record.primary;
    if (isRecord(primary)) {
      const nested = primary.BAT_M0_SOC_MIN;
      if (typeof nested === "number" && Number.isFinite(nested)) {
        return nested;
      }
    }
    return null;
  }

  private extractCurrentMode(payload: unknown): FroniusMode | null {
    if (!isRecord(payload)) {
      return null;
    }
    const record = payload;
    const direct = record.BAT_M0_SOC_MODE ?? record.bat_m0_soc_mode;
    const mode = this.normaliseMode(direct);
    if (mode) {
      return mode;
    }
    const primary = record.primary;
    if (isRecord(primary)) {
      return this.normaliseMode(primary.BAT_M0_SOC_MODE ?? primary.bat_m0_soc_mode);
    }
    return null;
  }

  private normaliseMode(value: unknown): FroniusMode | null {
    if (typeof value !== "string") {
      return null;
    }
    const lowered = value.trim().toLowerCase();
    if (lowered === "manual" || lowered === "charge") {
      return "charge";
    }
    if (lowered === "hold") {
      return "hold";
    }
    if (lowered === "auto") {
      return "auto";
    }
    return null;
  }

  private buildPayload(strategy: NormalisedStrategy): { body: Record<string, unknown>; target: Percentage | null } | null {
    const maxCharge = this.resolveMaxCharge();

    if (strategy.mode === "charge") {
      const target = maxCharge ?? Percentage.full();
      return {
        body: this.serializeManualTarget(target),
        target,
      };
    }

    if (strategy.mode === "hold") {
      const manualTarget = strategy.manualTarget;
      if (!manualTarget) {
        this.logger.warn("Hold strategy missing manual target; skipping update.");
        return null;
      }
      const floor = this.resolveAutoFloor(strategy.floorTarget ?? manualTarget);
      let target = manualTarget;
      if (target.ratio < floor.ratio) {
        target = floor;
      }
      if (maxCharge && target.ratio > maxCharge.ratio) {
        target = maxCharge;
      }
      return {
        body: this.serializeManualTarget(target),
        target,
      };
    }

    const floorSoc = this.resolveAutoFloor(strategy.floorTarget);
    return {
      body: {
        BAT_M0_SOC_MIN: this.toPercentInteger(floorSoc),
        BAT_M0_SOC_MODE: "auto",
      },
      target: floorSoc,
    };
  }

  private resolveAutoFloor(explicitFloor: Percentage | null): Percentage {
    const configFloor = this.autoModeFloorOverride;
    if (configFloor) {
      return configFloor;
    }
    if (explicitFloor) {
      return explicitFloor;
    }
    return Percentage.fromPercent(5);
  }

  private resolveMaxCharge(): Percentage | null {
    return this.maxChargeLimit;
  }

  private resolveChargeFloorPower(): Power | null {
    return this.chargeFloorPower;
  }

  private serializeManualTarget(target: Percentage): Record<string, unknown> {
    return {
      BAT_M0_SOC_MIN: this.toPercentInteger(target),
      BAT_M0_SOC_MODE: "manual",
    };
  }

  private parsePercentage(value: Percentage | number | null | undefined): Percentage | null {
    if (value instanceof Percentage) {
      return value;
    }
    if (value == null) {
      return null;
    }
    return Percentage.fromPercent(Math.min(Math.max(value, 0), 100));
  }

  private toPercentInteger(value: Percentage): number {
    return Math.round(value.percent);
  }

  private parsePositiveNumber(value: unknown): number | null {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return null;
    }
    return value;
  }

  private parsePositivePower(value: unknown): Power | null {
    const watts = this.parsePositiveNumber(value);
    return watts == null ? null : Power.fromWatts(watts);
  }

  private parseTimeZone(value: unknown): string | null {
    if (typeof value !== "string" || value.trim().length === 0) {
      return null;
    }
    const candidate = value.trim();
    try {
      new Intl.DateTimeFormat("en-GB", {timeZone: candidate}).format(new Date());
      return candidate;
    } catch {
      this.logger.warn(`Invalid configured timezone "${candidate}"; falling back to server timezone.`);
      return null;
    }
  }

  private buildUrl(host: string, path: string): string {
    const trimmedHost = host.endsWith("/") ? host.slice(0, -1) : host;
    const normalizedHost = trimmedHost.startsWith("http://") || trimmedHost.startsWith("https://")
      ? trimmedHost
      : `http://${trimmedHost}`;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${normalizedHost}${normalizedPath}`;
  }

  private buildBatteriesUrlCandidates(host: string, configuredPath: string): string[] {
    return this.buildConfigUrlCandidates(host, configuredPath);
  }

  private buildTimeOfUseUrlCandidates(host: string, configuredPath: string): string[] {
    return this.buildConfigUrlCandidates(host, configuredPath);
  }

  private buildConfigUrlCandidates(host: string, configuredPath: string): string[] {
    const normalizedPath = configuredPath.startsWith("/") ? configuredPath : `/${configuredPath}`;
    const candidates = [normalizedPath];
    if (normalizedPath.startsWith("/api/")) {
      candidates.push(normalizedPath.slice("/api".length));
    } else {
      candidates.push(`/api${normalizedPath}`);
    }
    const uniquePaths = [...new Set(candidates)];
    return uniquePaths.map((path) => this.buildUrl(host, path));
  }

  private extractApiPrefix(path: string): "/api" | "" {
    return path.startsWith("/api/") ? "/api" : "";
  }

  private buildCommandUrlCandidates(
    host: string,
    pathHint: string,
    command: "Login" | "Logout",
    query: Record<string, string> = {},
  ): string[] {
    const preferredPrefix = this.workingCommandsPrefix ?? this.extractApiPrefix(pathHint);
    const prefixes: ("/api" | "")[] = preferredPrefix === "/api" ? ["/api", ""] : ["", "/api"];
    const urls = prefixes.map((prefix) => {
      const base = this.buildUrl(host, `${prefix}/commands/${command}`);
      const search = new URLSearchParams(query).toString();
      return search.length ? `${base}?${search}` : base;
    });
    return [...new Set(urls)];
  }

  private async loginFroniusSession(config: FroniusConnectionConfig, batteriesPathHint: string): Promise<void> {
    const loginCandidates = this.buildCommandUrlCandidates(
      config.host,
      batteriesPathHint,
      "Login",
      {user: config.user},
    );
    let lastError: Error | null = null;
    for (const [index, loginUrl] of loginCandidates.entries()) {
      try {
        this.logger.log(`Logging in Fronius session via ${loginUrl}`);
        await this.requestJson("GET", loginUrl, config);
        this.workingCommandsPrefix = this.extractApiPrefix(new URL(loginUrl).pathname);
        return;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const canTryFallback = index < loginCandidates.length - 1;
        if (!canTryFallback || !this.isHttp404(error)) {
          throw error;
        }
        this.logger.warn(`Fronius login endpoint ${loginUrl} returned 404; trying fallback path.`);
      }
    }
    if (lastError) {
      throw lastError;
    }
  }

  private isHttp404(error: unknown): boolean {
    return describeError(error).toLowerCase().includes("http 404");
  }

  private async readTimeOfUseEntries(
    config: FroniusConnectionConfig,
  ): Promise<{entries: FroniusTimeOfUseEntry[]; path: string}> {
    const configuredPath = this.workingTimeOfUsePath ?? TIME_OF_USE_PATH;
    const urlCandidates = this.buildTimeOfUseUrlCandidates(config.host, configuredPath);
    let lastError: Error | null = null;
    for (const [index, url] of urlCandidates.entries()) {
      try {
        const payload = await this.requestJson("GET", url, config);
        this.workingTimeOfUsePath = new URL(url).pathname;
        return {
          entries: this.extractTimeOfUseEntries(payload),
          path: this.workingTimeOfUsePath,
        };
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const canTryFallback = index < urlCandidates.length - 1;
        if (!canTryFallback || !this.isHttp404(error)) {
          throw error;
        }
        this.logger.warn(`Fronius time-of-use endpoint ${url} returned 404; trying fallback path.`);
      }
    }
    if (lastError) {
      throw lastError;
    }
    throw new Error("Unable to read Fronius time-of-use configuration.");
  }

  private async writeTimeOfUseEntries(
    config: FroniusConnectionConfig,
    pathHint: string,
    entries: FroniusTimeOfUseEntry[],
  ): Promise<void> {
    const urlCandidates = this.buildTimeOfUseUrlCandidates(config.host, pathHint);
    let lastError: Error | null = null;
    for (const [index, url] of urlCandidates.entries()) {
      try {
        this.logger.log(`Updating Fronius time-of-use schedule via ${url}`);
        await this.requestJson("POST", url, config, {timeofuse: entries.map((entry) => this.serializeTimeOfUseEntry(entry))});
        this.workingTimeOfUsePath = new URL(url).pathname;
        return;
      } catch (error: unknown) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const canTryFallback = index < urlCandidates.length - 1;
        if (!canTryFallback || !this.isHttp404(error)) {
          throw error;
        }
        this.logger.warn(`Fronius time-of-use endpoint ${url} returned 404; trying fallback path.`);
      }
    }
    if (lastError) {
      throw lastError;
    }
  }

  private extractTimeOfUseEntries(payload: unknown): FroniusTimeOfUseEntry[] {
    if (!isRecord(payload) || !Array.isArray(payload.timeofuse)) {
      return [];
    }
    return payload.timeofuse
      .map((entry) => this.parseTimeOfUseEntry(entry))
      .filter((entry): entry is FroniusTimeOfUseEntry => entry !== null);
  }

  private parseTimeOfUseEntry(value: unknown): FroniusTimeOfUseEntry | null {
    if (!isRecord(value)) {
      return null;
    }
    const power = value.Power;
    const scheduleType = value.ScheduleType;
    const active = value.Active;
    const timeTable = this.parseTimeTable(value.TimeTable);
    const weekdays = this.parseWeekdays(value.Weekdays);
    if (
      typeof active !== "boolean" ||
      typeof power !== "number" ||
      !Number.isFinite(power) ||
      scheduleType !== "CHARGE_MIN" ||
      !timeTable ||
      !weekdays
    ) {
      return null;
    }
    return {
      Active: active,
      Power: Power.fromWatts(Math.round(power)),
      ScheduleType: "CHARGE_MIN",
      TimeTable: timeTable,
      Weekdays: weekdays,
    };
  }

  private parseTimeTable(value: unknown): FroniusTimeTable | null {
    if (!isRecord(value) || typeof value.Start !== "string" || typeof value.End !== "string") {
      return null;
    }
    return {
      Start: value.Start,
      End: value.End,
    };
  }

  private parseWeekdays(value: unknown): FroniusWeekdays | null {
    if (!isRecord(value)) {
      return null;
    }
    const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
    const weekdays = {} as FroniusWeekdays;
    for (const dayName of dayNames) {
      if (typeof value[dayName] !== "boolean") {
        return null;
      }
      weekdays[dayName] = value[dayName];
    }
    return weekdays;
  }

  private findExistingManagedTimeOfUseEntry(
    entries: FroniusTimeOfUseEntry[],
    managedPower: Power,
  ): FroniusTimeOfUseEntry | null {
    if (!this.lastManagedTimeOfUseEntry) {
      const tailEntry = entries.at(-1) ?? null;
      if (!tailEntry) {
        return null;
      }
      const activeDays = Object.values(tailEntry.Weekdays).filter(Boolean).length;
      if (tailEntry.Power.equals(managedPower) && activeDays === 1) {
        return tailEntry;
      }
      return null;
    }
    return entries.find((entry) => this.timeOfUseEntriesEqual([entry], [this.lastManagedTimeOfUseEntry as FroniusTimeOfUseEntry])) ?? null;
  }

  private buildManagedChargeFloorEntry(
    power: Power,
    active: boolean,
    chargeUntil: Date | null,
  ): FroniusTimeOfUseEntry {
    const now = new Date();
    const start = new Date(now);
    start.setSeconds(0, 0);
    const fallbackEnd = new Date(start.getTime() + this.chargeFloorWindowMinutes * 60_000);
    const startParts = this.getLocalDateParts(start);
    const end = chargeUntil && chargeUntil.getTime() > start.getTime()
      ? new Date(chargeUntil)
      : fallbackEnd;
    const endParts = this.getLocalDateParts(end);
    if (
      endParts.year !== startParts.year ||
      endParts.month !== startParts.month ||
      endParts.day !== startParts.day
    ) {
      return {
        Active: active,
        Power: power,
        ScheduleType: "CHARGE_MIN",
        TimeTable: {
          Start: this.formatClockTime(start),
          End: "23:59",
        },
        Weekdays: this.buildWeekdaysForDate(start),
      };
    }
    if (end.getTime() <= start.getTime()) {
      end.setTime(start.getTime() + 60_000);
    }
    return {
      Active: active,
      Power: power,
      ScheduleType: "CHARGE_MIN",
      TimeTable: {
        Start: this.formatClockTime(start),
        End: this.formatClockTime(end),
      },
      Weekdays: this.buildWeekdaysForDate(start),
    };
  }

  private buildWeekdaysForDate(date: Date): FroniusWeekdays {
    const weekdays: FroniusWeekdays = {
      Mon: false,
      Tue: false,
      Wed: false,
      Thu: false,
      Fri: false,
      Sat: false,
      Sun: false,
    };
    weekdays[this.getLocalDateParts(date).weekday] = true;
    return weekdays;
  }

  private formatClockTime(value: Date): string {
    const parts = this.getLocalDateParts(value);
    return `${parts.hour}:${parts.minute}`;
  }

  private getLocalDateParts(value: Date): LocalDateParts {
    if (!this.timeZone) {
      return {
        year: value.getFullYear(),
        month: value.getMonth() + 1,
        day: value.getDate(),
        weekday: this.systemWeekdayName(value),
        hour: value.getHours().toString().padStart(2, "0"),
        minute: value.getMinutes().toString().padStart(2, "0"),
      };
    }
    const formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: this.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const fields = formatter.formatToParts(value);
    const year = this.extractNumericDatePart(fields, "year");
    const month = this.extractNumericDatePart(fields, "month");
    const day = this.extractNumericDatePart(fields, "day");
    const hour = this.extractTextDatePart(fields, "hour");
    const minute = this.extractTextDatePart(fields, "minute");
    const weekdayToken = this.extractTextDatePart(fields, "weekday");
    const weekday = this.parseWeekdayName(weekdayToken);
    return {year, month, day, weekday, hour, minute};
  }

  private extractNumericDatePart(
    fields: Intl.DateTimeFormatPart[],
    partType: Intl.DateTimeFormatPartTypes,
  ): number {
    const value = this.extractTextDatePart(fields, partType);
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Unable to parse ${partType} from timezone-formatted date.`);
    }
    return parsed;
  }

  private extractTextDatePart(
    fields: Intl.DateTimeFormatPart[],
    partType: Intl.DateTimeFormatPartTypes,
  ): string {
    const match = fields.find((field) => field.type === partType)?.value;
    if (!match) {
      throw new Error(`Missing ${partType} in timezone-formatted date.`);
    }
    return match;
  }

  private parseWeekdayName(value: string): keyof FroniusWeekdays {
    const normalized = value.slice(0, 3);
    switch (normalized) {
      case "Mon":
      case "Tue":
      case "Wed":
      case "Thu":
      case "Fri":
      case "Sat":
      case "Sun":
        return normalized;
      default:
        throw new Error(`Unsupported weekday token "${value}" from timezone formatter.`);
    }
  }

  private systemWeekdayName(value: Date): keyof FroniusWeekdays {
    const dayIndex = value.getDay();
    const dayNames: (keyof FroniusWeekdays)[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    return dayNames[dayIndex];
  }

  private serializeTimeOfUseEntry(entry: FroniusTimeOfUseEntry): Record<string, unknown> {
    return {
      Active: entry.Active,
      Power: Math.round(entry.Power.watts),
      ScheduleType: entry.ScheduleType,
      TimeTable: entry.TimeTable,
      Weekdays: entry.Weekdays,
    };
  }

  private timeOfUseEntriesEqual(
    left: FroniusTimeOfUseEntry[],
    right: FroniusTimeOfUseEntry[],
  ): boolean {
    return JSON.stringify(left.map((entry) => this.serializeTimeOfUseEntry(entry)))
      === JSON.stringify(right.map((entry) => this.serializeTimeOfUseEntry(entry)));
  }

  private async requestJson(
    method: string,
    url: string,
    credentials: FroniusConnectionConfig,
    payload: Record<string, unknown> | null = null,
  ): Promise<unknown> {
    this.logger.log(`Fronius ${method.toUpperCase()} ${url}`);
    if (payload) {
      this.logger.verbose(`Fronius request payload: ${JSON.stringify(payload)}`);
    }
    const headers = new Headers({Accept: "application/json, text/plain, */*"});
    let body: string | undefined;
    if (payload) {
      body = JSON.stringify(payload);
      headers.set("Content-Type", "application/json");
    }

    const response = await this.performDigestRequest(method, url, credentials, headers, body);
    if (!response.ok) {
      let text: string;
      try {
        text = await response.text();
      } catch {
        text = "";
      }
      throw new Error(`HTTP ${response.status} ${response.statusText}${text ? `: ${text}` : ""}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      return response.json();
    }
    return null;
  }

  private async performDigestRequest(
    method: string,
    urlString: string,
    credentials: FroniusConnectionConfig,
    headers: Headers,
    body: string | undefined,
  ): Promise<Response> {
    const url = new URL(urlString);
    const {timeoutSeconds} = credentials;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.max(1, timeoutSeconds) * 1000);

    try {
      const requestInit = {
        method,
        headers,
        body,
        signal: controller.signal,
      } satisfies RequestInit;

      // If we have an active digest session, reuse it instead of re-challenging.
      if (this.digestSession) {
        const session = this.digestSession;
        session.nc++;
        const digestUri = this.buildDigestUriCandidates(url)[0];
        const authorization = this.buildSessionAuthorization(session, method, credentials.user, digestUri);
        headers.set("Authorization", authorization);
        const response = await fetch(url, requestInit);
        if (response.status !== 401) {
          return response;
        }
        // Session expired or rejected; fall through to fresh challenge.
        this.digestSession = null;
        this.logger.warn("Digest session rejected; re-authenticating.");
      }

      let response = await fetch(url, requestInit);

      if (response.status !== 401) {
        return response;
      }

      const challenge = response.headers.get("www-authenticate") ?? response.headers.get("x-www-authenticate");
      const params = challenge ? this.parseDigestChallenge(challenge) : null;
      if (!params) {
        return response;
      }

      const realm = params.realm ?? "";
      const nonce = params.nonce ?? "";
      const qop = (params.qop ?? "auth").split(",").map((s) => s.trim().toLowerCase()).find((s) => s.length) ?? "auth";
      // Fronius uses a mixed-hash scheme: HA1 is always MD5(user:realm:password),
      // even when the challenge algorithm is SHA256. The SHA256 algorithm only
      // governs the final digest response computation. Try MD5 HA1 first (matching
      // the Fronius UI behaviour), then fall back to standard SHA256 HA1.
      const ha1Candidates = [
        this.hashDigestValue("md5", `${credentials.user}:${realm}:${credentials.password}`),
        this.hashDigestValue("sha256", `${credentials.user}:${realm}:${credentials.password}`),
      ];

      for (const [index, ha1] of ha1Candidates.entries()) {
        const digestUriCandidates = this.buildDigestUriCandidates(url);
        for (const digestUri of digestUriCandidates) {
          const nc = 1;
          const cnonce = randomBytes(8).toString("hex");
          const ncHex = nc.toString().padStart(8, "0");
          const ha2 = this.hashDigestValue("sha256", `${method.toUpperCase()}:${digestUri}`);
          const responseValue = this.hashDigestValue(
            "sha256",
            `${ha1}:${nonce}:${ncHex}:${cnonce}:${qop}:${ha2}`,
          );

          const parts = [
            `username="${credentials.user}"`,
            `realm="${realm}"`,
            `nonce="${nonce}"`,
            `uri="${digestUri}"`,
            `response="${responseValue}"`,
            `qop=${qop}`,
            `nc=${ncHex}`,
            `cnonce="${cnonce}"`,
          ];
          headers.set("Authorization", `Digest ${parts.join(", ")}`);
          response = await fetch(url, requestInit);
          if (response.status !== 401) {
            if (index > 0) {
              this.logger.warn(
                `Fronius accepted credential variant #${index + 1} (standard ${index === 1 ? "SHA256" : "other"} HA1).`,
              );
            }
            // Establish digest session for subsequent requests.
            this.digestSession = {nonce, realm, qop, ha1, nc};
            return response;
          }
          const nextChallenge = response.headers.get("www-authenticate") ?? response.headers.get("x-www-authenticate");
          const nextParams = nextChallenge ? this.parseDigestChallenge(nextChallenge) : null;
          if (nextParams) {
            if (nextParams.nonce) {
              params.nonce = nextParams.nonce;
            }
          }
        }
      }

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private buildSessionAuthorization(
    session: DigestSession,
    method: string,
    username: string,
    digestUri: string,
  ): string {
    const ncHex = session.nc.toString().padStart(8, "0");
    const cnonce = randomBytes(8).toString("hex");
    const ha2 = this.hashDigestValue("sha256", `${method.toUpperCase()}:${digestUri}`);
    const responseValue = this.hashDigestValue(
      "sha256",
      `${session.ha1}:${session.nonce}:${ncHex}:${cnonce}:${session.qop}:${ha2}`,
    );
    const parts = [
      `username="${username}"`,
      `realm="${session.realm}"`,
      `nonce="${session.nonce}"`,
      `uri="${digestUri}"`,
      `response="${responseValue}"`,
      `qop=${session.qop}`,
      `nc=${ncHex}`,
      `cnonce="${cnonce}"`,
    ];
    return `Digest ${parts.join(", ")}`;
  }

  private parseDigestChallenge(header: string): Partial<Record<string, string>> | null {
    if (!header) {
      return null;
    }
    const prefixTrimmed = header.trim();
    const withoutScheme = prefixTrimmed.toLowerCase().startsWith(DIGEST_PREFIX)
      ? prefixTrimmed.slice(DIGEST_PREFIX.length).trim()
      : prefixTrimmed;

    const regex = /([a-zA-Z0-9_-]+)=(("[^"]*")|([^,]*))/g;
    const params: Partial<Record<string, string>> = {};
    let match: RegExpExecArray | null;
    while ((match = regex.exec(withoutScheme)) !== null) {
      const key = match[1].toLowerCase();
      const group3: string | undefined = match[3] as string | undefined;
      const group4: string | undefined = match[4] as string | undefined;
      const rawValue = group3 ?? group4 ?? "";
      params[key] = rawValue.replace(/^"|"$/g, "");
    }
    return Object.keys(params).length ? params : null;
  }

  private buildDigestUriCandidates(url: URL): string[] {
    if (!url.search) {
      return [url.pathname];
    }
    if (url.pathname.endsWith("/commands/Login")) {
      return [url.pathname, `${url.pathname}${url.search}`];
    }
    return [`${url.pathname}${url.search}`, url.pathname];
  }

  private hashDigestValue(algorithm: "md5" | "sha256", value: string): string {
    return createHash(algorithm).update(value).digest("hex");
  }

  private async logoutFroniusSession(config: FroniusConnectionConfig): Promise<void> {
    try {
      const pathHint = this.workingBatteriesPath ?? BATTERIES_PATH;
      const logoutCandidates = this.buildCommandUrlCandidates(config.host, pathHint, "Logout");
      for (const [index, logoutUrl] of logoutCandidates.entries()) {
        try {
          this.logger.log(`Logging out Fronius session via ${logoutUrl}`);
          await this.requestJson("GET", logoutUrl, config);
          this.workingCommandsPrefix = this.extractApiPrefix(new URL(logoutUrl).pathname);
          break;
        } catch (error: unknown) {
          const canTryFallback = index < logoutCandidates.length - 1;
          if (!canTryFallback || !this.isHttp404(error)) {
            throw error;
          }
          this.logger.warn(`Fronius logout endpoint ${logoutUrl} returned 404; trying fallback path.`);
        }
      }
      this.digestSession = null;
      this.logger.verbose("Fronius session logged out.");
    } catch (error) {
      this.digestSession = null;
      this.logger.verbose(`Fronius logout skipped: ${describeError(error)}`);
    }
  }

}

export function requireFroniusConnectionConfig(config: ConfigDocument): FroniusConnectionConfig | null {
  const record = config.fronius;
  if (!record?.enabled) {
    return null;
  }

  const hostRaw = record.host?.trim() ?? "";
  const userRaw = record.user?.trim() ?? "";
  const passwordRaw = record.password?.trim() ?? "";

  if (!hostRaw || !userRaw || !passwordRaw) {
    throw new Error("Fronius configuration requires host, user, and password when enabled.");
  }

  return {
    host: hostRaw,
    user: userRaw,
    password: passwordRaw,
    timeoutSeconds:
      typeof record.timeout_s === "number" && Number.isFinite(record.timeout_s) ? record.timeout_s : 6,
    verifyTls: record.verify_tls ?? false,
  } satisfies FroniusConnectionConfig;
}
