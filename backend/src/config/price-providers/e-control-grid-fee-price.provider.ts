import { Injectable, Logger } from "@nestjs/common";

import type {
  GridFeeTariffScheduleContext,
  GridFeeTariffScheduleProvider,
  PriceProviderRefreshContext,
} from "./price-provider.types";
import type { HistoryPoint, RawForecastEntry } from "@chargecaster/domain";
import { parseTimestamp } from "../../simulation/solar";
import type { DynamicPriceRecord } from "../../storage/storage.service";
import type { EControlNetzbereich } from "../schemas";

const REQUEST_TIMEOUT_MS = 15_000;
const E_CONTROL_SNE_GESETZESNUMMER = "20010107";
const RIS_BASE_URL = "https://www.ris.bka.gv.at";
const VAT_MULTIPLIER = 1.2;
// Households are typically billed on Netzebene 7 without demand metering
// ("nicht leistungsgemessen"). That shape still has energy-based ct/kWh
// charges, so it can be modeled as one bundled per-kWh grid fee here.
//
// Demand-metered ("leistungsgemessen") tariffs are different: they generally
// depend on measured peak kW and additional tariff dimensions, so they do not
// map cleanly onto Chargecaster's current single `grid_fee_eur_per_kwh` field.
// We therefore keep the public `e-control` option intentionally narrow instead
// of pretending to support every E-Control tariff class.
//
// This provider intentionally models only the usage-dependent household-style
// surcharge bucket:
// - regional Netznutzungsentgelt (Arbeit) for NE7 "bb) nicht gemessene Leist."
// - regional Netzverlustentgelt
// - nationwide Elektrizitätsabgabe
// - nationwide Erneuerbaren-Förderbeitrag (Arbeit / Verlust)
//
// Fixed Zählpunkt ("Euro/ZP") items such as Leistungspauschale, Messentgelt or
// Förderpauschalen are left out on purpose because they do not change the
// optimizer's hourly decision.
const SUPPORTED_NETZBEREICH = "Wien";
const SUPPORTED_NETZEBENE = 7;
const SUPPORTED_CUSTOMER_PROFILE = "residential_non_demand_metered";
const RESIDENTIAL_ELECTRICITY_TAX_PROFILE = "natural_person_skzg";

interface SnapWindow {
  startDay: number;
  startMonth: number;
  endDay: number;
  endMonth: number;
  startHour: number;
  endHour: number;
}

interface EControlGridFeeComponents {
  normalApCentPerKwh: number;
  snapApCentPerKwh: number;
  netzverlustCentPerKwh: number;
  renewableWorkCentPerKwh: number;
  renewableLossCentPerKwh: number;
  electricityTaxCentPerKwh: number;
}

@Injectable()
export class EControlGridFeePriceProvider implements GridFeeTariffScheduleProvider {
  readonly type = "e-control" as const;
  private readonly logger = new Logger(EControlGridFeePriceProvider.name);

  async refresh(context: PriceProviderRefreshContext): Promise<void> {
    // This provider currently reads the regulator tariff for the residential
    // configured Netzbereich / Netzebene 7 / non-demand-metered path. If we
    // later add broader E-Control support, that should happen via a richer
    // tariff model instead of overloading this one scalar grid-fee abstraction.
    const localDate = this.resolveLocalDate(context.referenceDate, context.timeZone);
    const effectiveAt = this.resolveYearStartIso(context.referenceDate, context.timeZone);
    const existingRecord = context.storage.getLatestDynamicPriceRecordForEffectiveAt(
      "grid_fee_eur_per_kwh",
      this.type,
      effectiveAt,
    );
    if (
      existingRecord &&
      this.resolveMonthKey(existingRecord.observedAt, context.timeZone) === this.resolveMonthKey(context.referenceDate, context.timeZone) &&
      this.hasCompleteSnapMetadata(existingRecord)
    ) {
      this.logger.verbose(
        `Skipping E-Control grid fee refresh for ${effectiveAt}; latest observation ${existingRecord.observedAt} is already from the current month`,
      );
      return;
    }

    const url = this.resolveSourceUrl(context.referenceDate, context.timeZone, context.config);
    const netzbereich = this.resolveNetzbereich(context.config);
    this.logger.log(`Refreshing E-Control grid fee from ${url}`);
    const [sneBody, renewablesDoc, electricityTaxDoc] = await Promise.all([
      this.fetchText(url),
      this.fetchBundesnormDocument({
        title: "Erneuerbaren-Förderbeitragsverordnung",
        localDate,
        paragraph: "2",
      }),
      this.fetchBundesnormDocument({
        title: "Elektrizitätsabgabegesetz",
        localDate,
        paragraph: "7",
      }),
    ]);
    const components = this.extractComponents(sneBody, renewablesDoc.body, electricityTaxDoc.body, netzbereich);
    const snapWindow = this.extractSnapWindow(sneBody);
    const normalGrossTotalCentPerKwh = this.computeGrossTotalCentPerKwh(components, false);
    const snapGrossTotalCentPerKwh = this.computeGrossTotalCentPerKwh(components, true);
    const valueEurPerKwh = normalGrossTotalCentPerKwh / 100;

    context.storage.upsertDynamicPriceRecord({
      priceKey: "grid_fee_eur_per_kwh",
      source: this.type,
      effectiveAt,
      observedAt: context.referenceDate.toISOString(),
      valueEurPerKwh,
      metadata: {
        url,
        netzbereich,
        netzebene: SUPPORTED_NETZEBENE,
        customer_profile: SUPPORTED_CUSTOMER_PROFILE,
        electricity_tax_profile: RESIDENTIAL_ELECTRICITY_TAX_PROFILE,
        sources: {
          systemnutzungsentgelte_url: url,
          erneuerbaren_foerderbeitrag_url: renewablesDoc.url,
          elektrizitaetsabgabe_url: electricityTaxDoc.url,
        },
        vat_multiplier: VAT_MULTIPLIER,
        snap: {
          enabled: this.resolveSnapEnabled(context.config),
          start_day: snapWindow.startDay,
          start_month: snapWindow.startMonth,
          end_day: snapWindow.endDay,
          end_month: snapWindow.endMonth,
          start_hour: snapWindow.startHour,
          end_hour: snapWindow.endHour,
        },
        components: {
          netznutzungsentgelt_ap_cent_per_kwh: components.normalApCentPerKwh,
          netznutzungsentgelt_snap_ap_cent_per_kwh: components.snapApCentPerKwh,
          netzverlustentgelt_cent_per_kwh: components.netzverlustCentPerKwh,
          erneuerbaren_foerderbeitrag_arbeit_cent_per_kwh: components.renewableWorkCentPerKwh,
          erneuerbaren_foerderbeitrag_verlust_cent_per_kwh: components.renewableLossCentPerKwh,
          elektrizitaetsabgabe_cent_per_kwh: components.electricityTaxCentPerKwh,
          total_net_cent_per_kwh: this.computeNetTotalCentPerKwh(components, false),
          total_gross_cent_per_kwh: normalGrossTotalCentPerKwh,
          total_net_snap_cent_per_kwh: this.computeNetTotalCentPerKwh(components, true),
          total_gross_snap_cent_per_kwh: snapGrossTotalCentPerKwh,
        },
      },
    });
  }

  buildTariffSchedule(context: GridFeeTariffScheduleContext): (number | undefined)[] | null {
    if (context.forecast?.length) {
      return context.forecast.map((entry) => {
        const timestamp = entry.start ?? entry.from ?? null;
        return timestamp ? this.resolvePriceAt(context, timestamp) ?? undefined : undefined;
      });
    }

    if (context.history?.length) {
      return context.history.map((entry) => this.resolvePriceAt(context, entry.timestamp) ?? undefined);
    }

    return null;
  }

  resolvePriceAt(context: GridFeeTariffScheduleContext, timestamp: string): number | null {
    const record = this.lookupDynamicPriceRecordAt(context, timestamp);
    if (!record) {
      return context.simulationConfig.price.grid_fee_eur_per_kwh ?? null;
    }
    return this.resolveGridFeeValueFromRecord(record, timestamp, this.resolveTimeZone(context.config));
  }

  private resolveNetzbereich(config: PriceProviderRefreshContext["config"]): EControlNetzbereich {
    return config.price?.grid_fee?.type === "e-control" ? (config.price.grid_fee.netzbereich ?? SUPPORTED_NETZBEREICH) : "Wien";
  }

  private resolveSnapEnabled(config: PriceProviderRefreshContext["config"]): boolean {
    if (config.price?.grid_fee?.type !== "e-control") {
      return true;
    }
    return config.price.grid_fee.snap ?? true;
  }

  private resolveTimeZone(config: PriceProviderRefreshContext["config"]): string {
    return config.location?.timezone?.trim() || "Europe/Vienna";
  }

  private resolveSourceUrl(referenceDate: Date, timeZone: string, config: PriceProviderRefreshContext["config"]): string {
    const legacyUrl = config.price?.dynamic?.e_control?.url?.trim() || config.price?.dynamic?.wiener_netze?.url?.trim();
    if (legacyUrl) {
      return legacyUrl;
    }
    const yearStart = this.resolveYearStartDate(referenceDate, timeZone);
    return `https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=${E_CONTROL_SNE_GESETZESNUMMER}&FassungVom=${yearStart}`;
  }

  private resolveYearStartDate(referenceDate: Date, timeZone: string): string {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
    });
    const parts = formatter.formatToParts(referenceDate);
    const year = parts.find((part) => part.type === "year")?.value ?? referenceDate.getUTCFullYear().toString();
    return `${year}-01-01`;
  }

  private resolveLocalDate(referenceDate: Date, timeZone: string): string {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = formatter.formatToParts(referenceDate);
    const get = (type: string, fallback: string) => parts.find((part) => part.type === type)?.value ?? fallback;
    return `${get("year", String(referenceDate.getUTCFullYear()))}-${get("month", String(referenceDate.getUTCMonth() + 1)).padStart(2, "0")}-${get("day", String(referenceDate.getUTCDate())).padStart(2, "0")}`;
  }

  private resolveYearStartIso(referenceDate: Date, timeZone: string): string {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
    });
    const parts = formatter.formatToParts(referenceDate);
    const year = parts.find((part) => part.type === "year")?.value ?? referenceDate.getUTCFullYear().toString();
    return this.resolveLocalMidnightUtcIso(Number(year), 1, 1, timeZone);
  }

  private resolveMonthKey(referenceDate: Date | string, timeZone: string): string {
    const date = typeof referenceDate === "string" ? new Date(referenceDate) : referenceDate;
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
    });
    const parts = formatter.formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value ?? String(date.getUTCFullYear());
    const month = parts.find((part) => part.type === "month")?.value ?? String(date.getUTCMonth() + 1).padStart(2, "0");
    return `${year}-${month}`;
  }

  private extractComponents(
    sneBody: string,
    renewablesBody: string,
    electricityTaxBody: string,
    netzbereich: EControlNetzbereich,
  ): EControlGridFeeComponents {
    const {normalApCentPerKwh, snapApCentPerKwh} = this.extractNetznutzungsentgeltApCentPerKwh(sneBody, netzbereich);
    return {
      normalApCentPerKwh,
      snapApCentPerKwh,
      netzverlustCentPerKwh: this.extractPatternValue(sneBody, this.buildNetzverlustPattern(netzbereich), 1),
      renewableWorkCentPerKwh: this.extractRenewableWorkCentPerKwh(renewablesBody),
      renewableLossCentPerKwh: this.extractRenewableLossCentPerKwh(renewablesBody),
      electricityTaxCentPerKwh: this.extractResidentialElectricityTaxCentPerKwh(electricityTaxBody),
    };
  }

  private extractNetznutzungsentgeltApCentPerKwh(body: string, netzbereich: EControlNetzbereich): {
    normalApCentPerKwh: number;
    snapApCentPerKwh: number;
  } {
    const section = this.extractSection(body, `Netznutzungsentgelt für die Netzebene ${SUPPORTED_NETZEBENE}:`, "Netzbereitstellungsentgelt");
    const regionBlock = this.extractRegionBlock(section, netzbereich);
    const rowMatch = /bb\)\s*nicht gemessene Leist\.[\s\S]*?AlignRight">([^<]+)<\/p>[\s\S]*?AlignRight">([^<]+)<\/p>[\s\S]*?AlignRight">([^<]+)<\/p>/i.exec(regionBlock);
    const apRaw = rowMatch?.[2];
    const snapRaw = rowMatch?.[3];
    if (!apRaw) {
      throw new Error(`Unable to extract E-Control Netznutzungsentgelt AP for ${netzbereich}.`);
    }
    return {
      normalApCentPerKwh: this.parseEuropeanNumber(apRaw),
      snapApCentPerKwh: snapRaw ? this.parseEuropeanNumber(snapRaw) : this.parseEuropeanNumber(apRaw),
    };
  }

  private resolveGridFeeValueFromRecord(record: DynamicPriceRecord, timestamp: string, timeZone: string): number {
    const metadata = record.metadata;
    const components = this.extractComponentsFromMetadata(metadata);
    if (!components) {
      return record.valueEurPerKwh;
    }
    const snapEnabled = this.extractSnapEnabledFromMetadata(metadata);
    const snapWindow = this.extractSnapWindowFromMetadata(metadata);
    const snapActive = snapEnabled && snapWindow ? this.isSnapActive(timestamp, timeZone, snapWindow) : false;
    return this.computeGrossTotalCentPerKwh(components, snapActive) / 100;
  }

  private extractComponentsFromMetadata(metadata: Record<string, unknown>): EControlGridFeeComponents | null {
    const components = this.asRecord(metadata.components);
    if (!components) {
      return null;
    }
    const normalApCentPerKwh = this.asNumber(components.netznutzungsentgelt_ap_cent_per_kwh);
    const snapApCentPerKwh = this.asNumber(components.netznutzungsentgelt_snap_ap_cent_per_kwh);
    const netzverlustCentPerKwh = this.asNumber(components.netzverlustentgelt_cent_per_kwh);
    const renewableWorkCentPerKwh = this.asNumber(components.erneuerbaren_foerderbeitrag_arbeit_cent_per_kwh);
    const renewableLossCentPerKwh = this.asNumber(components.erneuerbaren_foerderbeitrag_verlust_cent_per_kwh);
    const electricityTaxCentPerKwh = this.asNumber(components.elektrizitaetsabgabe_cent_per_kwh);
    if (
      normalApCentPerKwh == null ||
      snapApCentPerKwh == null ||
      netzverlustCentPerKwh == null ||
      renewableWorkCentPerKwh == null ||
      renewableLossCentPerKwh == null ||
      electricityTaxCentPerKwh == null
    ) {
      return null;
    }
    return {
      normalApCentPerKwh,
      snapApCentPerKwh,
      netzverlustCentPerKwh,
      renewableWorkCentPerKwh,
      renewableLossCentPerKwh,
      electricityTaxCentPerKwh,
    };
  }

  private extractSnapEnabledFromMetadata(metadata: Record<string, unknown>): boolean {
    const snap = this.asRecord(metadata.snap);
    const enabled = snap ? this.asBoolean(snap.enabled) : null;
    return enabled ?? true;
  }

  private extractSnapWindow(body: string): SnapWindow {
    const normalizedBody = body
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ");
    const match = /Sommer-Nieder-Arbeitspreis\s*\(SNAP\).*?im Zeitraum von\s*(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+)\s*bis\s*(\d{1,2})\.\s*([A-Za-zÄÖÜäöü]+),\s*jeweils\s*(\d{1,2})\s*bis\s*(\d{1,2})\s*Uhr/i.exec(
      normalizedBody,
    );
    if (!match) {
      throw new Error("Unable to extract SNAP validity window from the official SNE-V source.");
    }
    const startMonth = this.parseGermanMonth(match[2]);
    const endMonth = this.parseGermanMonth(match[4]);
    return {
      startDay: Number(match[1]),
      startMonth,
      endDay: Number(match[3]),
      endMonth,
      startHour: Number(match[5]),
      endHour: Number(match[6]),
    };
  }

  private extractSnapWindowFromMetadata(metadata: Record<string, unknown>): SnapWindow | null {
    const snap = this.asRecord(metadata.snap);
    if (!snap) {
      return null;
    }
    const startDay = this.asNumber(snap.start_day);
    const startMonth = this.asNumber(snap.start_month);
    const endDay = this.asNumber(snap.end_day);
    const endMonth = this.asNumber(snap.end_month);
    const startHour = this.asNumber(snap.start_hour);
    const endHour = this.asNumber(snap.end_hour);
    if (
      startDay == null ||
      startMonth == null ||
      endDay == null ||
      endMonth == null ||
      startHour == null ||
      endHour == null
    ) {
      return null;
    }
    return {
      startDay,
      startMonth,
      endDay,
      endMonth,
      startHour,
      endHour,
    };
  }

  private computeNetTotalCentPerKwh(components: EControlGridFeeComponents, useSnap: boolean): number {
    return (
      (useSnap ? components.snapApCentPerKwh : components.normalApCentPerKwh) +
      components.netzverlustCentPerKwh +
      components.renewableWorkCentPerKwh +
      components.renewableLossCentPerKwh +
      components.electricityTaxCentPerKwh
    );
  }

  private computeGrossTotalCentPerKwh(components: EControlGridFeeComponents, useSnap: boolean): number {
    return this.computeNetTotalCentPerKwh(components, useSnap) * VAT_MULTIPLIER;
  }

  private lookupDynamicPriceRecordAt(context: GridFeeTariffScheduleContext, timestamp: string): DynamicPriceRecord | null {
    const storage = context.storage as StorageServiceLike;
    if (typeof storage.getLatestDynamicPriceRecordAt === "function") {
      return storage.getLatestDynamicPriceRecordAt("grid_fee_eur_per_kwh", this.type, timestamp);
    }
    if (typeof storage.getLatestDynamicPriceRecordsAt === "function") {
      const record = storage.getLatestDynamicPriceRecordsAt(timestamp).grid_fee_eur_per_kwh ?? null;
      return record?.source === this.type ? record : null;
    }
    return null;
  }

  private hasCompleteSnapMetadata(record: DynamicPriceRecord): boolean {
    return this.extractComponentsFromMetadata(record.metadata) !== null &&
      this.extractSnapWindowFromMetadata(record.metadata) !== null;
  }

  private isSnapActive(timestamp: string, timeZone: string, snapWindow: SnapWindow): boolean {
    const date = parseTimestamp(timestamp);
    if (!date) {
      return false;
    }
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(date);
    const day = Number(parts.find((part) => part.type === "day")?.value ?? Number.NaN);
    const month = Number(parts.find((part) => part.type === "month")?.value ?? Number.NaN);
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? Number.NaN);
    if (!Number.isFinite(day) || !Number.isFinite(month) || !Number.isFinite(hour)) {
      return false;
    }
    const isAfterOrEqualStart = month > snapWindow.startMonth || (month === snapWindow.startMonth && day >= snapWindow.startDay);
    const isBeforeOrEqualEnd = month < snapWindow.endMonth || (month === snapWindow.endMonth && day <= snapWindow.endDay);
    return isAfterOrEqualStart && isBeforeOrEqualEnd && hour >= snapWindow.startHour && hour < snapWindow.endHour;
  }

  private parseGermanMonth(rawMonth: string): number {
    const normalized = rawMonth
      .trim()
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "");
    const monthMap: Record<string, number> = {
      januar: 1,
      februar: 2,
      maerz: 3,
      marz: 3,
      april: 4,
      mai: 5,
      juni: 6,
      juli: 7,
      august: 8,
      september: 9,
      oktober: 10,
      november: 11,
      dezember: 12,
    };
    const month = monthMap[normalized];
    if (!month) {
      throw new Error(`Unsupported German month in official SNAP source: ${rawMonth}`);
    }
    return month;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }

  private asNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  private asBoolean(value: unknown): boolean | null {
    return typeof value === "boolean" ? value : null;
  }

  private extractSection(body: string, startMarker: string, endMarker: string): string {
    const start = body.indexOf(startMarker);
    if (start < 0) {
      throw new Error(`Unable to find E-Control section '${startMarker}'.`);
    }
    const end = body.indexOf(endMarker, start);
    if (end < 0) {
      throw new Error(`Unable to find end marker '${endMarker}' after '${startMarker}'.`);
    }
    return body.slice(start, end);
  }

  private extractRegionBlock(section: string, netzbereich: EControlNetzbereich): string {
    const escaped = this.escapeRegex(netzbereich);
    const startMatch = new RegExp(`Bereich ${escaped}:`, "i").exec(section);
    if (!startMatch || startMatch.index == null) {
      throw new Error(`Unable to find E-Control region block for ${netzbereich}.`);
    }
    const remainder = section.slice(startMatch.index);
    const nextRegionMatch = /<p class="TabText AlignLeft">Bereich [^<]+:<\/p>/i.exec(remainder.slice(startMatch[0].length));
    const endIndex = nextRegionMatch?.index != null ? startMatch[0].length + nextRegionMatch.index : remainder.length;
    return remainder.slice(0, endIndex);
  }

  private buildNetzverlustPattern(netzbereich: EControlNetzbereich): RegExp {
    const escaped = this.escapeRegex(netzbereich);
    return new RegExp(
      `Netzverlustentgelt[\\s\\S]*?${escaped}:<\\/p><\\/td>[\\s\\S]*?<p class="TabTextRechtsb AlignRight">([0-9]+,[0-9]+)<\\/p>\\s*<\\/td>\\s*<\\/tr>`,
      "is",
    );
  }

  private extractRenewableWorkCentPerKwh(body: string): number {
    const match = /nicht gemessene Leistung\)[\s\S]*?([0-9]+,[0-9]+)\s*Cent\/kWh/i.exec(body);
    const rawValue = match?.[1];
    if (!rawValue) {
      throw new Error("Unable to extract Erneuerbaren-Förderbeitrag (Arbeit) for Netzebene 7.");
    }
    return this.parseEuropeanNumber(rawValue);
  }

  private extractRenewableLossCentPerKwh(body: string): number {
    const match = /Netzverlustentgelt[\s\S]*?Netzebene 7[\s\S]*?([0-9]+,[0-9]+)\s*Cent\/kWh/i.exec(body);
    const rawValue = match?.[1];
    if (!rawValue) {
      throw new Error("Unable to extract Erneuerbaren-Förderbeitrag (Verlust) for Netzebene 7.");
    }
    return this.parseEuropeanNumber(rawValue);
  }

  private extractResidentialElectricityTaxCentPerKwh(body: string): number {
    const match = /([0-9]+,[0-9]+)\s*Euro je kWh für die Lieferung von elektrischer Energie an natürliche Personen/i.exec(body);
    const rawValue = match?.[1];
    if (!rawValue) {
      throw new Error("Unable to extract residential Elektrizitätsabgabe rate.");
    }
    return this.parseEuropeanNumber(rawValue) * 100;
  }

  private async fetchBundesnormDocument(input: {title: string; localDate: string; paragraph: string}): Promise<{url: string; body: string}> {
    const searchUrl = `${RIS_BASE_URL}/Ergebnis.wxe?Abfrage=Bundesnormen&Titel=${encodeURIComponent(input.title)}&FassungVom=${input.localDate}&ResultPageSize=20`;
    const searchBody = await this.fetchText(searchUrl);
    const documentId = this.extractBundesnormDocumentId(searchBody, input.paragraph);
    const url = `${RIS_BASE_URL}/Dokumente/Bundesnormen/${documentId}/${documentId}.html`;
    return {
      url,
      body: await this.fetchText(url),
    };
  }

  private extractBundesnormDocumentId(searchBody: string, paragraph: string): string {
    const paragraphPattern = paragraph.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(
      `&#167;\\s*${paragraphPattern}</a>[\\s\\S]*?href="/Dokumente/Bundesnormen/(NOR[0-9]+)\\/\\1\\.html"`,
      "i",
    ).exec(searchBody);
    const documentId = match?.[1];
    if (!documentId) {
      throw new Error(`Unable to locate RIS document id for § ${paragraph}.`);
    }
    return documentId;
  }

  private resolveLocalMidnightUtcIso(year: number, month: number, day: number, timeZone: string): string {
    const initialGuessUtcMs = Date.UTC(year, month - 1, day, 0, 0, 0);
    const offsetMs = this.resolveTimeZoneOffsetMs(new Date(initialGuessUtcMs), timeZone);
    const resolvedUtcMs = initialGuessUtcMs - offsetMs;
    const correctedOffsetMs = this.resolveTimeZoneOffsetMs(new Date(resolvedUtcMs), timeZone);
    return new Date(initialGuessUtcMs - correctedOffsetMs).toISOString();
  }

  private resolveTimeZoneOffsetMs(date: Date, timeZone: string): number {
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const parts = formatter.formatToParts(date);
    const get = (type: string, fallback: string) => Number(parts.find((part) => part.type === type)?.value ?? fallback);
    const year = get("year", String(date.getUTCFullYear()));
    const month = get("month", String(date.getUTCMonth() + 1));
    const day = get("day", String(date.getUTCDate()));
    const hour = get("hour", String(date.getUTCHours()));
    const minute = get("minute", String(date.getUTCMinutes()));
    const second = get("second", String(date.getUTCSeconds()));
    return Date.UTC(year, month - 1, day, hour, minute, second) - date.getTime();
  }

  private extractPatternValue(body: string, pattern: RegExp, group: number): number {
    const match = pattern.exec(body);
    const rawValue = match?.[group];
    if (!rawValue) {
      throw new Error(`Configured E-Control pattern did not match value for group ${group}.`);
    }
    return this.parseEuropeanNumber(rawValue);
  }

  private parseEuropeanNumber(raw: string): number {
    const normalized = raw.trim().replace(/\./g, "").replace(",", ".");
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Unable to parse numeric value '${raw}'.`);
    }
    return parsed;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private async fetchText(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(url, {signal: controller.signal});
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }
}

interface StorageServiceLike {
  getLatestDynamicPriceRecordAt?: (
    priceKey: DynamicPriceRecord["priceKey"],
    source: string,
    timestamp: string,
  ) => DynamicPriceRecord | null;
  getLatestDynamicPriceRecordsAt?: (
    timestamp: string,
  ) => Partial<Record<DynamicPriceRecord["priceKey"], DynamicPriceRecord>>;
}
