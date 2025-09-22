import { Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";

import type { JsonObject } from "../common/json.ts";
import { isJsonObject } from "../common/json.ts";
import type { SnapshotPayload } from "../simulation/types.ts";

interface FroniusConfig {
  host: string;
  user: string;
  password: string;
  batteriesPath: string;
  timeoutSeconds: number;
  verifyTls: boolean;
}

const DIGEST_PREFIX = "digest";

@Injectable()
export class FroniusService {
  private readonly logger = new Logger(FroniusService.name);
  private lastAppliedTarget: number | null = null;
  private lastAppliedMode: "charge" | "auto" | null = null;

  async applyOptimization(config: JsonObject, snapshot: SnapshotPayload): Promise<void> {
    const froniusConfig = this.extractConfig(config);
    if (!froniusConfig) {
      return;
    }

    const desiredMode = this.resolveDesiredMode(snapshot);

    const url = this.buildUrl(froniusConfig.host, froniusConfig.batteriesPath);

    try {
      // const currentConfig = await this.requestJson("GET", url, froniusConfig);
      // const currentMode = this.extractCurrentMode(currentConfig);
      if (this.lastAppliedMode === desiredMode) {
        this.logger.log(`Fronius already in ${desiredMode} mode; skipping update.`);
        return;
      }

      const payload = this.buildPayload(config, snapshot, desiredMode);
      if (!payload) {
        this.logger.warn("Unable to construct Fronius payload; skipping update.");
        return;
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
    } catch (error: unknown) {
      this.logger.warn(`Fronius update failed: ${this.describeError(error)}`);
    }
  }

  private extractConfig(config: JsonObject): FroniusConfig | null {
    const record = config.fronius;
    if (!isJsonObject(record)) {
      return null;
    }
    const hostRaw = record.host;
    const userRaw = record.user;
    const passwordRaw = record.password;
    if (typeof hostRaw !== "string" || typeof userRaw !== "string" || typeof passwordRaw !== "string") {
      return null;
    }

    const batteriesPathRaw = record.batteries_path;
    const timeoutRaw = record.timeout_s;
    const verifyRaw = record.verify_tls;

    return {
      host: hostRaw.trim(),
      user: userRaw,
      password: passwordRaw,
      batteriesPath: typeof batteriesPathRaw === "string" && batteriesPathRaw.length ? batteriesPathRaw : "/config/batteries",
      timeoutSeconds: typeof timeoutRaw === "number" ? timeoutRaw : Number(timeoutRaw ?? 6) || 6,
      verifyTls: typeof verifyRaw === "boolean" ? verifyRaw : Boolean(verifyRaw ?? false),
    } satisfies FroniusConfig;
  }

  private resolveDesiredMode(snapshot: SnapshotPayload): "charge" | "auto" {
    if (snapshot.current_mode === "charge" || snapshot.current_mode === "auto") {
      return snapshot.current_mode;
    }
    const currentSoc = typeof snapshot.current_soc_percent === "number" ? snapshot.current_soc_percent : null;
    const nextSoc = typeof snapshot.next_step_soc_percent === "number" ? snapshot.next_step_soc_percent : null;
    if (currentSoc !== null && nextSoc !== null && nextSoc > currentSoc + 0.5) {
      return "charge";
    }
    return "auto";
  }

  private extractCurrentTarget(payload: unknown): number | null {
    if (!isJsonObject(payload)) {
      return null;
    }
    const record = payload;
    const direct = record.BAT_M0_SOC_MIN ?? record.bat_m0_soc_min;
    if (typeof direct === "number" && Number.isFinite(direct)) {
      return direct;
    }
    const primary = record.primary;
    if (isJsonObject(primary)) {
      const nested = primary.BAT_M0_SOC_MIN;
      if (typeof nested === "number" && Number.isFinite(nested)) {
        return nested;
      }
    }
    return null;
  }

  private extractCurrentMode(payload: unknown): "charge" | "auto" | null {
    if (!isJsonObject(payload)) {
      return null;
    }
    const record = payload;
    const direct = record.BAT_M0_SOC_MODE ?? record.bat_m0_soc_mode;
    const mode = this.normaliseMode(direct);
    if (mode) {
      return mode;
    }
    const primary = record.primary;
    if (isJsonObject(primary)) {
      return this.normaliseMode(primary.BAT_M0_SOC_MODE ?? primary.bat_m0_soc_mode);
    }
    return null;
  }

  private normaliseMode(value: unknown): "charge" | "auto" | null {
    if (typeof value !== "string") {
      return null;
    }
    const lowered = value.trim().toLowerCase();
    if (lowered === "manual" || lowered === "charge") {
      return "charge";
    }
    if (lowered === "auto") {
      return "auto";
    }
    return null;
  }

  private buildPayload(
    config: JsonObject,
    snapshot: SnapshotPayload,
    mode: "charge" | "auto",
  ): JsonObject | null {
    if (mode === "charge") {
      return {BAT_M0_SOC_MIN: 100, BAT_M0_SOC_MODE: "manual"};
    }
    const floorSoc = this.resolveAutoFloor(config, snapshot);
    return {BAT_M0_SOC_MIN: floorSoc, BAT_M0_SOC_MODE: "auto"};
  }

  private resolveAutoFloor(config: JsonObject, snapshot: SnapshotPayload): number {
    const batteryCfg = isJsonObject(config.battery) ? config.battery : null;
    const configFloor = batteryCfg && typeof batteryCfg.auto_mode_floor_soc === "number"
      ? batteryCfg.auto_mode_floor_soc
      : null;
    if (typeof configFloor === "number" && Number.isFinite(configFloor)) {
      return this.clampSoc(configFloor);
    }
    const snapshotNext = snapshot.next_step_soc_percent;
    if (typeof snapshotNext === "number" && Number.isFinite(snapshotNext)) {
      return this.clampSoc(Math.max(0, Math.min(snapshotNext, 100)));
    }
    return 5;
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
    payload: JsonObject | null = null,
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

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
