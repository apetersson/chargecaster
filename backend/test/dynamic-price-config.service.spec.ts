import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConfigDocument } from "../src/config/schemas";
import { DynamicPriceConfigService } from "../src/config/dynamic-price-config.service";
import { AwattarSunnyFeedInPriceProvider } from "../src/config/price-providers/awattar-sunny-feed-in-price.provider";
import { AwattarSunnySpotFeedInPriceProvider } from "../src/config/price-providers/awattar-sunny-spot-feed-in-price.provider";
import { EControlGridFeePriceProvider } from "../src/config/price-providers/e-control-grid-fee-price.provider";
import { StorageService } from "../src/storage/storage.service";

type FetchResult = Awaited<ReturnType<typeof global.fetch>>;

const createTextResponse = (body: string): FetchResult => ({
  ok: true,
  status: 200,
  statusText: "OK",
  text: () => Promise.resolve(body),
}) as FetchResult;

const createJsonResponse = (payload: unknown): FetchResult => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: () => Promise.resolve(payload),
}) as FetchResult;

const mockEControlOfficialFetches = (values: {
  netznutzungHtml: string;
  netzverlustHtml: string;
  renewablesWorkCentPerKwh: string;
  renewablesLossCentPerKwh: string;
  electricityTaxEuroPerKwh: string;
}) => {
  vi.spyOn(global, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("Gesetzesnummer=20010107")) {
      return createTextResponse(`
        <div>Netznutzungsentgelt für die Netzebene 7:</div>
        ${values.netznutzungHtml}
        <div>Netzbereitstellungsentgelt</div>
        <div>Netzverlustentgelt</div>
        ${values.netzverlustHtml}
      `);
    }
    if (url.includes("Titel=Erneuerbaren-F%C3%B6rderbeitragsverordnung")) {
      return createTextResponse(`
        <tr>
          <td><a title="Erneuerbaren-Förderbeitragsverordnung 2026">&#167; 2</a></td>
          <td><span class="nativeDocumentLinkCell"><a href="/Dokumente/Bundesnormen/NOR40273599/NOR40273599.html" target="_blank" title="Web-Seite: § 2 Erneuerbaren-Förderbeitragsverordnung 2026"></a></span></td>
        </tr>
      `);
    }
    if (url.includes("/Dokumente/Bundesnormen/NOR40273599/NOR40273599.html")) {
      return createTextResponse(`
        <div>Erneuerbaren-Förderbeitragsverordnung 2026</div>
        <div>nicht gemessene Leistung) ......................................... ......... ${values.renewablesWorkCentPerKwh} Cent/kWh;</div>
        <div>Netzverlustentgelt gelten für das Kalenderjahr 2026 folgende Beträge:</div>
        <div>6. auf der Netzebene 7 ..................................................................................... ......... ${values.renewablesLossCentPerKwh} Cent/kWh.</div>
      `);
    }
    if (url.includes("Titel=Elektrizit%C3%A4tsabgabegesetz")) {
      return createTextResponse(`
        <tr>
          <td><a title="Elektrizitätsabgabegesetz">&#167; 7</a></td>
          <td><span class="nativeDocumentLinkCell"><a href="/Dokumente/Bundesnormen/NOR40273847/NOR40273847.html" target="_blank" title="Web-Seite: § 7 Elektrizitätsabgabegesetz"></a></span></td>
        </tr>
      `);
    }
    if (url.includes("/Dokumente/Bundesnormen/NOR40273847/NOR40273847.html")) {
      return createTextResponse(`
        <div>(16) Abweichend von § 4 Abs. 2 beträgt die Abgabe</div>
        <div>${values.electricityTaxEuroPerKwh} Euro je kWh für die Lieferung von elektrischer Energie an natürliche Personen</div>
      `);
    }
    throw new Error(`Unexpected fetch URL in test: ${url}`);
  });
};

describe("DynamicPriceConfigService", () => {
  let tempDir: string | null = null;
  let storage: StorageService | null = null;

  afterEach(() => {
    vi.restoreAllMocks();
    if (storage) {
      storage.onModuleDestroy();
      storage = null;
    }
    if (tempDir) {
      rmSync(tempDir, {recursive: true, force: true});
      tempDir = null;
    }
    delete process.env.CHARGECASTER_STORAGE_PATH;
  });

  const createService = (): DynamicPriceConfigService => {
    tempDir = mkdtempSync(join(tmpdir(), "chargecaster-dynamic-prices-"));
    process.env.CHARGECASTER_STORAGE_PATH = join(tempDir, "backend.sqlite");
    storage = new StorageService();
    return new DynamicPriceConfigService(
      storage,
      new EControlGridFeePriceProvider(),
      new AwattarSunnyFeedInPriceProvider(),
      new AwattarSunnySpotFeedInPriceProvider(),
    );
  };

  it("stores and applies aWATTar SUNNY feed-in history by effective month", async () => {
    const service = createService();
    const config: ConfigDocument = {
      dry_run: true,
      price: {
        feed_in: {
          type: "awattar-sunny",
        },
      },
      location: {
        timezone: "Europe/Vienna",
      },
    };

    vi.spyOn(global, "fetch").mockResolvedValueOnce(createTextResponse(`
      <table>
        <tr><td>Einspeisevergütung</td><td>5,415 Cent/kWh</td></tr>
      </table>
    `));

    const applied = await service.refreshAndApply(config, new Date("2026-03-23T10:00:00.000Z"));

    expect(applied.price?.feed_in_tariff_eur_per_kwh).toBeCloseTo(0.05415, 6);
    expect(storage?.listDynamicPriceRecords()).toEqual([
      expect.objectContaining({
        priceKey: "feed_in_tariff_eur_per_kwh",
        source: "awattar-sunny",
        effectiveAt: "2026-02-28T23:00:00.000Z",
      }),
    ]);
  });

  it("loads the E-Control grid fee through the provider abstraction", async () => {
    const service = createService();
    const config: ConfigDocument = {
      dry_run: true,
      price: {
        grid_fee: {
          type: "e-control",
          netzbereich: "Wien",
        },
      },
      location: {
        timezone: "Europe/Vienna",
      },
    };

    mockEControlOfficialFetches({
      netznutzungHtml: `
        <p>Bereich Wien:</p></td>
        <tr><td><p class="TabTextBlock AlignJustify">aa) gemessene Leistung</p></td>
        <td><p class="TabTextRechtsb AlignRight">8 292</p></td>
        <td><p class="TabTextRechtsb AlignRight">4,21</p></td>
        <td><p class="TabTextRechtsb AlignRight">3,37</p></td></tr>
        <tr><td><p class="TabTextBlock AlignJustify">bb) nicht gemessene Leist.</p></td>
        <td><p class="TabTextRechtsb AlignRight">5 400 /Jahr</p></td>
        <td><p class="TabTextRechtsb AlignRight">6,98</p></td>
        <td><p class="TabTextRechtsb AlignRight">5,58</p></td></tr>
      `,
      netzverlustHtml: `
        <p>Wien:</p></td>
        <td><p class="TabTextRechtsb AlignRight">0,700</p></td></tr>
      `,
      renewablesWorkCentPerKwh: "0,583",
      renewablesLossCentPerKwh: "0,037",
      electricityTaxEuroPerKwh: "0,001",
    });

    const applied = await service.refreshAndApply(config, new Date("2026-01-08T08:00:00.000Z"));

    expect(global.fetch).toHaveBeenCalledWith(
      "https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=20010107&FassungVom=2026-01-01",
      expect.objectContaining({signal: expect.any(AbortSignal)}),
    );
    expect(applied.price?.grid_fee_eur_per_kwh).toBeCloseTo(0.1008, 6);
    expect(storage?.listDynamicPriceRecords()).toEqual([
      expect.objectContaining({
        priceKey: "grid_fee_eur_per_kwh",
        source: "e-control",
        effectiveAt: "2025-12-31T23:00:00.000Z",
        metadata: expect.objectContaining({
          netzbereich: "Wien",
          netzebene: 7,
          customer_profile: "residential_non_demand_metered",
          vat_multiplier: 1.2,
          components: expect.objectContaining({
            total_net_cent_per_kwh: expect.closeTo(8.4, 6),
            total_gross_cent_per_kwh: expect.closeTo(10.08, 6),
          }),
        }),
      }),
    ]);
  });

  it("loads the E-Control grid fee for the configured netzbereich", async () => {
    const service = createService();
    const config: ConfigDocument = {
      dry_run: true,
      price: {
        grid_fee: {
          type: "e-control",
          netzbereich: "Graz",
        },
      },
      location: {
        timezone: "Europe/Vienna",
      },
    };

    mockEControlOfficialFetches({
      netznutzungHtml: `
        <p>Bereich Graz:</p></td>
        <tr><td><p class="TabTextBlock AlignJustify">aa) gemessene Leistung</p></td>
        <td><p class="TabTextRechtsb AlignRight">4 692</p></td>
        <td><p class="TabTextRechtsb AlignRight">4,23</p></td>
        <td><p class="TabTextRechtsb AlignRight">3,38</p></td></tr>
        <tr><td><p class="TabTextBlock AlignJustify">bb) nicht gemessene Leist.</p></td>
        <td><p class="TabTextRechtsb AlignRight">5 400 /Jahr</p></td>
        <td><p class="TabTextRechtsb AlignRight">5,17</p></td>
        <td><p class="TabTextRechtsb AlignRight">4,14</p></td></tr>
      `,
      netzverlustHtml: `
        <p>Graz:</p></td>
        <td><p class="TabTextRechtsb AlignRight">0,658</p></td></tr>
      `,
      renewablesWorkCentPerKwh: "0,583",
      renewablesLossCentPerKwh: "0,037",
      electricityTaxEuroPerKwh: "0,001",
    });

    const applied = await service.refreshAndApply(config, new Date("2026-01-08T08:00:00.000Z"));

    expect(applied.price?.grid_fee_eur_per_kwh).toBeCloseTo(0.078576, 6);
    expect(storage?.listDynamicPriceRecords()).toEqual([
      expect.objectContaining({
        priceKey: "grid_fee_eur_per_kwh",
        source: "e-control",
        metadata: expect.objectContaining({
          netzbereich: "Graz",
        }),
      }),
    ]);
  });

  it("reuses the stored E-Control observation within the same local month", async () => {
    const service = createService();
    const fetchSpy = vi.spyOn(global, "fetch");
    storage?.upsertDynamicPriceRecord({
      priceKey: "grid_fee_eur_per_kwh",
      source: "e-control",
      effectiveAt: "2025-12-31T23:00:00.000Z",
      observedAt: "2026-01-08T08:00:00.000Z",
      valueEurPerKwh: 0.1008,
      metadata: {revision: 1},
    });

    const applied = await service.refreshAndApply({
      dry_run: true,
      price: {
        grid_fee: {
          type: "e-control",
          netzbereich: "Wien",
        },
      },
      location: {
        timezone: "Europe/Vienna",
      },
    }, new Date("2026-01-20T08:00:00.000Z"));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(applied.price?.grid_fee_eur_per_kwh).toBeCloseTo(0.1008, 6);
    expect(storage?.listDynamicPriceRecords().filter((row) => row.priceKey === "grid_fee_eur_per_kwh")).toHaveLength(1);
  });

  it("refreshes the E-Control grid fee again after the month rolls over", async () => {
    const service = createService();
    storage?.upsertDynamicPriceRecord({
      priceKey: "grid_fee_eur_per_kwh",
      source: "e-control",
      effectiveAt: "2025-12-31T23:00:00.000Z",
      observedAt: "2026-01-08T08:00:00.000Z",
      valueEurPerKwh: 0.1008,
      metadata: {revision: 1},
    });

    mockEControlOfficialFetches({
      netznutzungHtml: `
        <p>Bereich Wien:</p></td>
        <tr><td><p class="TabTextBlock AlignJustify">aa) gemessene Leistung</p></td>
        <td><p class="TabTextRechtsb AlignRight">8 292</p></td>
        <td><p class="TabTextRechtsb AlignRight">4,21</p></td>
        <td><p class="TabTextRechtsb AlignRight">3,37</p></td></tr>
        <tr><td><p class="TabTextBlock AlignJustify">bb) nicht gemessene Leist.</p></td>
        <td><p class="TabTextRechtsb AlignRight">5 400 /Jahr</p></td>
        <td><p class="TabTextRechtsb AlignRight">7,05</p></td>
        <td><p class="TabTextRechtsb AlignRight">5,64</p></td></tr>
      `,
      netzverlustHtml: `
        <p>Wien:</p></td>
        <td><p class="TabTextRechtsb AlignRight">0,710</p></td></tr>
      `,
      renewablesWorkCentPerKwh: "0,583",
      renewablesLossCentPerKwh: "0,037",
      electricityTaxEuroPerKwh: "0,001",
    });

    const applied = await service.refreshAndApply({
      dry_run: true,
      price: {
        grid_fee: {
          type: "e-control",
          netzbereich: "Wien",
        },
      },
      location: {
        timezone: "Europe/Vienna",
      },
    }, new Date("2026-02-02T08:00:00.000Z"));

    expect(global.fetch).toHaveBeenCalled();
    expect(applied.price?.grid_fee_eur_per_kwh).toBeCloseTo(0.10176, 6);
    expect(storage?.listDynamicPriceRecords().filter((row) => row.priceKey === "grid_fee_eur_per_kwh")).toHaveLength(2);
  });

  it("stores SUNNY Spot hourly feed-in history and applies the current hour", async () => {
    const service = createService();
    const config: ConfigDocument = {
      dry_run: true,
      price: {
        feed_in: {
          type: "awattar-sunny-spot",
        },
        energy: {
          awattar: {
            priority: 1,
            max_hours: 24,
          },
        },
      },
    };

    vi.spyOn(global, "fetch").mockResolvedValueOnce(createJsonResponse({
      data: [
        {
          start_timestamp: Date.parse("2026-03-23T10:00:00.000Z"),
          end_timestamp: Date.parse("2026-03-23T11:00:00.000Z"),
          marketprice: 100,
          unit: "Eur/MWh",
        },
        {
          start_timestamp: Date.parse("2026-03-23T11:00:00.000Z"),
          end_timestamp: Date.parse("2026-03-23T12:00:00.000Z"),
          marketprice: -50,
          unit: "Eur/MWh",
        },
      ],
    }));

    const applied = await service.refreshAndApply(config, new Date("2026-03-23T10:15:00.000Z"));

    expect(applied.price?.feed_in_tariff_eur_per_kwh).toBeCloseTo(0.081, 6);
    expect(storage?.listDynamicPriceRecords()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        priceKey: "feed_in_tariff_eur_per_kwh",
        source: "awattar-sunny-spot",
        effectiveAt: "2026-03-23T10:00:00.000Z",
        valueEurPerKwh: 0.081,
      }),
      expect.objectContaining({
        priceKey: "feed_in_tariff_eur_per_kwh",
        source: "awattar-sunny-spot",
        effectiveAt: "2026-03-23T11:00:00.000Z",
        valueEurPerKwh: expect.closeTo(-0.0595, 6),
      }),
    ]));
  });

  it("derives SUNNY Spot hourly tariffs from raw market forecast slots", () => {
    const service = createService();
    const config: ConfigDocument = {
      dry_run: true,
      price: {
        feed_in: {
          type: "awattar-sunny-spot",
        },
      },
    };

    const result = service.buildFeedInTariffScheduleFromForecast(
      config,
      {
        battery: {
          capacity_kwh: 10,
          max_charge_power_w: 5000,
        },
        price: {
          grid_fee_eur_per_kwh: 0.04,
          feed_in_tariff_eur_per_kwh: 0.05,
        },
        logic: {},
      },
      [
        {
          start: "2026-03-23T10:00:00.000Z",
          end: "2026-03-23T11:00:00.000Z",
          price: 0.1,
          unit: "EUR/kWh",
        },
        {
          start: "2026-03-23T11:00:00.000Z",
          end: "2026-03-23T12:00:00.000Z",
          price: -0.05,
          unit: "EUR/kWh",
        },
      ],
    );

    expect(result?.[0]).toBeCloseTo(0.081, 6);
    expect(result?.[1]).toBeCloseTo(-0.0595, 6);
  });

  it("applies the latest effective override available at the requested timestamp", () => {
    const service = createService();
    storage?.upsertDynamicPriceRecord({
      priceKey: "feed_in_tariff_eur_per_kwh",
      source: "awattar-sunny",
      effectiveAt: "2026-02-01T00:00:00.000Z",
      observedAt: "2026-02-01T08:00:00.000Z",
      valueEurPerKwh: 0.04,
      metadata: {},
    });
    storage?.upsertDynamicPriceRecord({
      priceKey: "feed_in_tariff_eur_per_kwh",
      source: "awattar-sunny",
      effectiveAt: "2026-03-01T00:00:00.000Z",
      observedAt: "2026-03-01T08:00:00.000Z",
      valueEurPerKwh: 0.05,
      metadata: {},
    });

    const config: ConfigDocument = {
      dry_run: true,
      price: {
        feed_in: {
          type: "awattar-sunny",
        },
      },
    };

    expect(service.applyStoredOverrides(config, "2026-02-20T00:00:00.000Z").price?.feed_in_tariff_eur_per_kwh).toBe(0.04);
    expect(service.applyStoredOverrides(config, "2026-03-20T00:00:00.000Z").price?.feed_in_tariff_eur_per_kwh).toBe(0.05);
  });

  it("maps static price providers onto simulation scalars without refresh", () => {
    const service = createService();
    const applied = service.applyStoredOverrides({
      dry_run: true,
      price: {
        grid_fee: {
          type: "static",
          eur_per_kwh: 0.12,
        },
        feed_in: {
          type: "static",
          eur_per_kwh: 0.07,
        },
      },
    });

    expect(applied.price?.grid_fee_eur_per_kwh).toBe(0.12);
    expect(applied.price?.feed_in_tariff_eur_per_kwh).toBe(0.07);
  });

  it("preserves multiple observations for the same effective tariff window", () => {
    const service = createService();
    storage?.upsertDynamicPriceRecord({
      priceKey: "grid_fee_eur_per_kwh",
      source: "e-control",
      effectiveAt: "2025-12-31T23:00:00.000Z",
      observedAt: "2026-01-08T08:00:00.000Z",
      valueEurPerKwh: 0.0407,
      metadata: {revision: 1},
    });
    storage?.upsertDynamicPriceRecord({
      priceKey: "grid_fee_eur_per_kwh",
      source: "e-control",
      effectiveAt: "2025-12-31T23:00:00.000Z",
      observedAt: "2026-01-09T08:00:00.000Z",
      valueEurPerKwh: 0.0412,
      metadata: {revision: 2},
    });

    const rows = storage?.listDynamicPriceRecords() ?? [];

    expect(service.getSelectedPriceOverrides({
      dry_run: true,
      price: {
        grid_fee: {
          type: "e-control",
        },
      },
    }, "2026-01-10T00:00:00.000Z").grid_fee_eur_per_kwh).toBe(0.0412);
    expect(rows.filter((row) => row.priceKey === "grid_fee_eur_per_kwh")).toHaveLength(2);
  });
});
