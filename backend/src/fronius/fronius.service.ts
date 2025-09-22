import { Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";

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

  async applyOptimization(config: Record<string, unknown>, snapshot: SnapshotPayload): Promise<void> {
    const froniusConfig = this.extractConfig(config);
    if (!froniusConfig) {
      return;
    }

    const targetPercent = this.resolveTargetSoc(snapshot);
    if (targetPercent === null) {
      return;
    }

    const url = this.buildUrl(froniusConfig.host, froniusConfig.batteriesPath);

    try {
      const currentConfig = await this.requestJson("GET", url, froniusConfig);
      const currentTarget = this.extractCurrentTarget(currentConfig);
      const roundedTarget = Math.max(0, Math.min(100, Math.round(targetPercent)));

      if (currentTarget !== null && Math.abs(currentTarget - roundedTarget) < 0.5) {
        this.lastAppliedTarget = roundedTarget;
        return;
      }

      if (this.lastAppliedTarget !== null && Math.abs(this.lastAppliedTarget - roundedTarget) < 0.5) {
        return;
      }

      const payload = {
        BAT_M0_SOC_MIN: roundedTarget,
        BAT_M0_SOC_MODE: "manual",
      };

      await this.requestJson("POST", url, froniusConfig, payload);
      this.lastAppliedTarget = roundedTarget;
      this.logger.log(`Updated Fronius battery target to ${roundedTarget}%`);
    } catch (error: unknown) {
      this.logger.warn(`Fronius update failed: ${this.describeError(error)}`);
    }
  }

  private extractConfig(config: Record<string, unknown>): FroniusConfig | null {
    const record = config?.fronius;
    if (!record || typeof record !== "object") {
      return null;
    }
    const hostRaw = (record as Record<string, unknown>).host;
    const userRaw = (record as Record<string, unknown>).user;
    const passwordRaw = (record as Record<string, unknown>).password;
    if (typeof hostRaw !== "string" || typeof userRaw !== "string" || typeof passwordRaw !== "string") {
      return null;
    }

    const batteriesPathRaw = (record as Record<string, unknown>).batteries_path;
    const timeoutRaw = (record as Record<string, unknown>).timeout_s;
    const verifyRaw = (record as Record<string, unknown>).verify_tls;

    return {
      host: hostRaw.trim(),
      user: userRaw,
      password: passwordRaw,
      batteriesPath: typeof batteriesPathRaw === "string" && batteriesPathRaw.length ? batteriesPathRaw : "/config/batteries",
      timeoutSeconds: typeof timeoutRaw === "number" ? timeoutRaw : Number(timeoutRaw ?? 6) || 6,
      verifyTls: typeof verifyRaw === "boolean" ? verifyRaw : Boolean(verifyRaw ?? false),
    } satisfies FroniusConfig;
  }

  private resolveTargetSoc(snapshot: SnapshotPayload): number | null {
    const candidates = [
      snapshot.recommended_final_soc_percent,
      snapshot.recommended_soc_percent,
      snapshot.next_step_soc_percent,
    ];
    for (const value of candidates) {
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
    return null;
  }

  private extractCurrentTarget(payload: unknown): number | null {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    const record = payload as Record<string, unknown>;
    const direct = record.BAT_M0_SOC_MIN ?? record.bat_m0_soc_min;
    if (typeof direct === "number" && Number.isFinite(direct)) {
      return direct;
    }
    const primary = record.primary;
    if (primary && typeof primary === "object") {
      const nested = (primary as Record<string, unknown>).BAT_M0_SOC_MIN;
      if (typeof nested === "number" && Number.isFinite(nested)) {
        return nested;
      }
    }
    return null;
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
    const headers = new Headers({ Accept: "application/json, text/plain, */*" });
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
    const { timeoutSeconds } = credentials;
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
