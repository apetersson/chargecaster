import { Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";

import type { ConfigDocument } from "../config/schemas";
import type { SnapshotPayload } from "@chargecaster/domain";

interface FroniusConfig {
  host: string;
  user: string;
  password: string;
  batteriesPath: string;
  timeoutSeconds: number;
  verifyTls: boolean;
}

const DIGEST_PREFIX = "digest";

const AUTH_ERROR_SUMMARY_MESSAGE = "Unable to control battery because of authentication problem.";

export interface FroniusApplyResult {
  errorMessage: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type FroniusMode = "charge" | "auto" | "hold";

@Injectable()

export class FroniusService {
  private readonly logger = new Logger(FroniusService.name);
  private lastAppliedTarget: number | null = null;
  private lastAppliedMode: FroniusMode | null = null;

  async applyOptimization(config: ConfigDocument, snapshot: SnapshotPayload): Promise<FroniusApplyResult> {
    const froniusConfig = this.extractConfig(config);
    if (!froniusConfig) {
      return {errorMessage: null};
    }

    const desiredMode = this.resolveDesiredMode(snapshot);

    const url = this.buildUrl(froniusConfig.host, froniusConfig.batteriesPath);

    try {
      // const currentConfig = await this.requestJson("GET", url, froniusConfig);
      // const currentMode = this.extractCurrentMode(currentConfig);
      if (this.lastAppliedMode === desiredMode) {
        this.logger.log(`Fronius already in ${desiredMode} mode; skipping update.`);
        return {errorMessage: null};
      }

      if (desiredMode === "hold") {
        this.logger.log("Fronius hold strategy requested; leaving inverter settings unchanged.");
        this.lastAppliedMode = "hold";
        return {errorMessage: null};
      }

      const payload = this.buildPayload(config, snapshot, desiredMode);
      if (!payload) {
        this.logger.warn("Unable to construct Fronius payload; skipping update.");
        return {errorMessage: null};
      }

      this.logger.log(
        `Issuing Fronius command ${JSON.stringify(payload)} (mode=${desiredMode}) to ${url}`,
      );
      await this.requestJson("POST", url, froniusConfig, payload);
      this.lastAppliedMode = desiredMode;
      if (typeof payload.BAT_M0_SOC_MIN === "number") {
        this.lastAppliedTarget = payload.BAT_M0_SOC_MIN;
      }
      this.logger.log("Fronius command applied successfully.");
      await this.logoutFroniusSession(froniusConfig);
      return {errorMessage: null};
    } catch (error: unknown) {
      this.logger.warn(`Fronius update failed: ${this.describeError(error)}`);
      return {errorMessage: this.normaliseSummaryError(error)};
    }
  }

  private normaliseSummaryError(error: unknown): string | null {
    if (!error) {
      return null;
    }
    const message = this.describeError(error).toLowerCase();
    if (!message) {
      return null;
    }
    if (message.includes("401") || message.includes("unauthorized") || message.includes("unauthorised")) {
      return AUTH_ERROR_SUMMARY_MESSAGE;
    }
    return null;
  }

  private extractConfig(config: ConfigDocument): FroniusConfig | null {
    const record = config.fronius;
    if (!record?.enabled) {
      return null;
    }
    const hostRaw = record.host?.trim() ?? "";
    const userRaw = record.user ?? "";
    const passwordRaw = record.password ?? "";
    if (!hostRaw || !userRaw || !passwordRaw) {
      return null;
    }

    return {
      host: hostRaw,
      user: userRaw,
      password: passwordRaw,
      batteriesPath: record.batteries_path?.length ? record.batteries_path : "/config/batteries",
      timeoutSeconds:
        typeof record.timeout_s === "number" && Number.isFinite(record.timeout_s) ? record.timeout_s : 6,
      verifyTls: record.verify_tls ?? false,
    } satisfies FroniusConfig;
  }

  private resolveDesiredMode(snapshot: SnapshotPayload): FroniusMode {
    if (snapshot.current_mode === "charge" || snapshot.current_mode === "auto" || snapshot.current_mode === "hold") {
      return snapshot.current_mode;
    }
    const currentSoCPercent = typeof snapshot.current_soc_percent === "number" ? snapshot.current_soc_percent : null;
    const nextSoCPercent = typeof snapshot.next_step_soc_percent === "number" ? snapshot.next_step_soc_percent : null;
    if (currentSoCPercent !== null && nextSoCPercent !== null && nextSoCPercent > currentSoCPercent + 0.5) {
      return "charge";
    }
    if (currentSoCPercent !== null && nextSoCPercent !== null && Math.abs(nextSoCPercent - currentSoCPercent) <= 0.5) {
      return "hold";
    }
    return "auto";
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

  private buildPayload(
    config: ConfigDocument,
    snapshot: SnapshotPayload,
    mode: FroniusMode,
  ): Record<string, unknown> | null {
    const currentSocRaw = typeof snapshot.current_soc_percent === "number" ? snapshot.current_soc_percent : null;

    const maxCharge = this.resolveMaxCharge(config);

    if (mode === "charge") {
      const target = maxCharge ?? 100;
      return {
        BAT_M0_SOC_MIN: this.clampSoc(target),
        BAT_M0_SOC_MODE: "manual",
      };
    }

    if (mode === "hold") {
      const floor = this.resolveAutoFloor(config, snapshot);
      const fallbackTarget = currentSocRaw ?? this.lastAppliedTarget ?? (maxCharge ?? 100);
      let target = Math.max(floor, fallbackTarget);
      if (maxCharge !== null && maxCharge !== undefined) {
        target = Math.min(target, maxCharge);
      }
      if (!Number.isFinite(target)) {
        return null;
      }
      return {
        BAT_M0_SOC_MIN: this.clampSoc(target),
        BAT_M0_SOC_MODE: "manual",
      };
    }

    const floorSoc = this.resolveAutoFloor(config, snapshot);
    return {BAT_M0_SOC_MIN: floorSoc, BAT_M0_SOC_MODE: "auto"};
  }

  private resolveAutoFloor(config: ConfigDocument, snapshot: SnapshotPayload): number {
    const configFloor = config.battery?.auto_mode_floor_soc ?? null;
    if (typeof configFloor === "number" && Number.isFinite(configFloor)) {
      return this.clampSoc(configFloor);
    }
    const snapshotNext = snapshot.next_step_soc_percent;
    if (typeof snapshotNext === "number" && Number.isFinite(snapshotNext)) {
      return this.clampSoc(Math.max(0, Math.min(snapshotNext, 100)));
    }
    return 5;
  }

  private resolveMaxCharge(config: ConfigDocument): number | null {
    const maxCharge = config.battery?.max_charge_soc_percent;
    if (typeof maxCharge !== "number" || !Number.isFinite(maxCharge)) {
      return null;
    }
    return this.clampSoc(maxCharge);
  }

  private clampSoc(value: number): number {
    if (!Number.isFinite(value)) {
      return 5;
    }
    if (value < 0) {
      return 0;
    }
    if (value > 100) {
      return 100;
    }
    return Math.round(value);
  }

  private buildUrl(host: string, path: string): string {
    const trimmedHost = host.endsWith("/") ? host.slice(0, -1) : host;
    const normalizedHost = trimmedHost.startsWith("http://") || trimmedHost.startsWith("https://")
      ? trimmedHost
      : `http://${trimmedHost}`;
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return `${normalizedHost}${normalizedPath}`;
  }

  private async requestJson(
    method: string,
    url: string,
    credentials: FroniusConfig,
    payload: Record<string, unknown> | null = null,
  ): Promise<unknown> {
    const headers = new Headers({Accept: "application/json, text/plain, */*"});
    let body: string | undefined;
    if (payload) {
      body = JSON.stringify(payload);
      headers.set("Content-Type", "application/json");
    }

    const response = await this.performDigestRequest(method, url, credentials, headers, body);
    if (!response.ok) {
      let text = "";
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
    credentials: FroniusConfig,
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

      let response = await fetch(url, requestInit);

      if (response.status !== 401) {
        return response;
      }

      const challenge = response.headers.get("www-authenticate") ?? response.headers.get("x-www-authenticate");
      const params = challenge ? this.parseDigestChallenge(challenge) : null;
      if (!params) {
        return response;
      }

      const authorization = this.buildDigestAuthorization(params, method, url, credentials.user, credentials.password);
      headers.set("Authorization", authorization);

      response = await fetch(url, requestInit);

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private parseDigestChallenge(header: string): Record<string, string> | null {
    if (!header) {
      return null;
    }
    const prefixTrimmed = header.trim();
    const withoutScheme = prefixTrimmed.toLowerCase().startsWith(DIGEST_PREFIX)
      ? prefixTrimmed.slice(DIGEST_PREFIX.length).trim()
      : prefixTrimmed;

    const regex = /([a-zA-Z0-9_-]+)=(("[^"]*")|([^,]*))/g;
    const params: Record<string, string> = {};
    let match: RegExpExecArray | null;
    while ((match = regex.exec(withoutScheme)) !== null) {
      const key = match[1].toLowerCase();
      const rawValue = match[3] ?? match[4] ?? "";
      params[key] = rawValue.replace(/^"|"$/g, "");
    }
    return Object.keys(params).length ? params : null;
  }

  private buildDigestAuthorization(
    params: Record<string, string>,
    method: string,
    url: URL,
    username: string,
    password: string,
  ): string {
    const realm = params.realm ?? "";
    const nonce = params.nonce ?? "";
    if (!realm || !nonce) {
      throw new Error("Invalid digest challenge: missing realm or nonce");
    }

    const qopRaw = params.qop ?? "auth";
    const qop = qopRaw.split(",").map((item) => item.trim().toLowerCase()).find((item) => item.length) ?? "auth";
    const algorithm = (params.algorithm ?? "MD5").toUpperCase();
    if (algorithm !== "MD5") {
      throw new Error(`Unsupported digest algorithm '${algorithm}'`);
    }

    const uri = url.pathname + (url.search ?? "");
    const nc = "00000001";
    const cnonce = randomBytes(8).toString("hex");

    const ha1 = createHash("md5").update(`${username}:${realm}:${password}`).digest("hex");
    const ha2 = createHash("md5").update(`${method.toUpperCase()}:${uri}`).digest("hex");

    const responseValue = qop
      ? createHash("md5").update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`).digest("hex")
      : createHash("md5").update(`${ha1}:${nonce}:${ha2}`).digest("hex");

    const parts = [
      `username="${username}"`,
      `realm="${realm}"`,
      `nonce="${nonce}"`,
      `uri="${uri}"`,
      `response="${responseValue}"`,
      `algorithm="${algorithm}"`,
    ];

    if (qop) {
      parts.push(`qop=${qop}`);
      parts.push(`nc=${nc}`);
      parts.push(`cnonce="${cnonce}"`);
    }

    if (params.opaque) {
      parts.push(`opaque="${params.opaque}"`);
    }

    return `Digest ${parts.join(", ")}`;
  }

  private async logoutFroniusSession(config: FroniusConfig): Promise<void> {
    const logoutUrl = this.buildUrl(config.host, "/commands/Logout");
    try {
      await this.requestJson("GET", logoutUrl, config);
      this.logger.debug("Fronius session logged out.");
    } catch (error) {
      this.logger.debug(`Fronius logout skipped: ${this.describeError(error)}`);
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
