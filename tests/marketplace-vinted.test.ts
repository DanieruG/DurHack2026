// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableJavaScriptEvaluation":true,"disableJavaScriptFileLoading":true,"disableCSSFileLoading":true,"disableIframePageLoading":true,"disableComputedStyleRendering":true,"handleDisabledFileLoadingAsSuccess":true}}
import { beforeAll, describe, expect, it } from "vitest";
import { prepareCapture, structuredListing, type RawCapture } from "@/extension/src/lib/capture";
import { CaptureSchema, type ListingFacts } from "@/schemas/domain";
import { mergeListingFacts, redactListingData } from "@/pipeline/listingData";
import { checkPrice } from "@/pipeline/checks/price";
import { checkFit } from "@/pipeline/checks/fit";
import { generateNextMoves } from "@/pipeline/nextMoves";
import { detectWarningSignals } from "@/pipeline/signals";
import { summariseOffers } from "@/lib/newPrices";
import { prepareText } from "@/pipeline/intake";
import { collectFixture, VINTED_FIXTURE } from "./listingFixtures";
import fs from "node:fs";
import path from "node:path";
import type { SizeChart } from "@/schemas/seed";

let raw: RawCapture;
beforeAll(() => {
  raw = collectFixture(VINTED_FIXTURE);
});

const PHOTOS = [
  "https://images1.vinted.net/t/02_025be_ez2cSR77HdXjQ5MuDPEhxLx2/f800/06ff978a.webp?s=2daaca958d8093238fed87d7df7e9b5eecd96e5b",
  "https://images1.vinted.net/t/03_0040a_1752ys4DFRaeUirQis3GskJi/f800/be644bf3.webp?s=249f29117fb2f94b306efc8e164d4e6b9b6958da",
  "https://images1.vinted.net/t/06_01fd5_RRfmSXmeYYQKJKTxaWYU3FY3/f800/e400ccda.webp?s=331d1e8ea1856715985362ec6c60ef1eb9f6e7e1",
];
const DESCRIPTION =
  "Nike P6000, Mens US 14 grey runners. \n\nPre worn but still in great condition, no holes or damage in the fabric. A little worn on the bottom but plenty of life left. \n\nSmoke free home, shoes have been thoroughly cleaned.";

const needs = { sizes: [{ brand: "Nike", size: 9, system: "UK" as const }], priorities: [], wearTolerance: "light" as const, extraPriorities: [], assumptions: [] };
// The real Nike men's chart (data/), which goes up to US 15.
const charts = (JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "sizecharts.json"), "utf8")) as SizeChart[]);
const nikeChart = () => charts.find((c) => c.id === "nike-mens")!;
const geminiFacts = (over: Partial<ListingFacts> = {}): ListingFacts => ({ platform: "vinted", photoCount: 4, conditionClaims: [], evidence: [], ...over });

describe("Vinted item page fixture: structured extraction", () => {
  it("reads every attribute and the full description from the page data", () => {
    const { listing } = structuredListing(raw)!;
    expect(listing).toMatchObject({
      title: { value: "Grey Nike P6000 - Men’s size 14", source: "structured_data" },
      brand: { value: "Nike", source: "structured_data" },
      size: { value: "14", source: "structured_data" },
      condition: { value: "Very good", source: "structured_data" },
      colour: { value: "Grey, White", source: "structured_data" },
      material: { value: "Suede, Mesh", source: "structured_data" },
      uploadDate: { value: "a day ago", source: "structured_data" },
      category: { value: "Men Trainers", source: "structured_data" },
      verificationAvailable: true,
    });
    expect(listing.description).toEqual({ value: DESCRIPTION, source: "structured_data" });
    expect(listing.dominantColourHint).toBe("#E0DDD9"); // the backdrop, a weak hint only
  });

  it("takes all 4 photos from the item's photos array at full size", () => {
    const { capture } = prepareCapture(raw);
    expect(capture.imageUrls).toHaveLength(4);
    expect(capture.imageUrls!.slice(0, 3)).toEqual(PHOTOS);
    for (const u of capture.imageUrls!) expect(u).toMatch(/^https:\/\/images1\.vinted\.net\/t\/[^/]+\/f800\//);
    expect(capture.listing?.photos).toEqual({ captured: 4, shown: 4 });
  });

  it("uses the GBP asking price, ignores JSON-LD's 40 AUD, and records the AUD amount as evidence", () => {
    const { listing } = structuredListing(raw)!;
    const ld = JSON.parse(raw.embedded!.jsonLd.find((t) => t.includes('"Product"'))!);
    expect(ld.offers).toMatchObject({ priceCurrency: "AUD", price: 40 });
    expect(listing.priceGBP).toEqual({ value: 20.75, source: "structured_data" });
    expect(listing.sellerPrice).toEqual({ amount: 40, currency: "AUD", source: "structured_data" });
    expect(prepareCapture(raw).preview.priceGBP).toBe(20.75);
    const facts = mergeListingFacts(geminiFacts({ priceGBP: 40 }), listing);
    expect(facts.priceGBP).toBe(20.75);
    expect(facts.evidence.find((e) => e.label.startsWith("Seller listed it at"))?.label).toBe("Seller listed it at 40 AUD (from the page's data)");
  });

  it("reads buyer protection, postage and the total", () => {
    const { listing } = structuredListing(raw)!;
    expect(listing.buyerProtectionGBP).toEqual({ value: 1.74, source: "structured_data" });
    expect(listing.postageGBP).toEqual({ value: 8.69, source: "structured_data" });
    expect(listing.totalGBP).toEqual({ value: 31.18, source: "structured_data" });
    const facts = mergeListingFacts(geminiFacts(), listing);
    expect(facts).toMatchObject({ totalGBP: 31.18, totalIncludes: ["buyer_protection", "postage"] });
  });

  it("finds the size system in the description (US 14), not by assuming UK", () => {
    const { listing } = structuredListing(raw)!;
    expect(listing.sizeSystem).toEqual({ value: "US", source: "page_field", foundIn: "description", quote: "Nike P6000, Mens US 14" });
    const facts = mergeListingFacts(geminiFacts({ sizeText: "UK 14", sizeSystem: "UK" }), listing);
    expect(facts).toMatchObject({ sizeText: "14", sizeSystem: "US", fieldSources: { size: "structured_data", sizeSystem: "page_field" } });
  });

  it("fit for a UK 9 user: US 14 is several sizes too big", () => {
    const facts = mergeListingFacts(geminiFacts(), structuredListing(raw)!.listing);
    const fit = checkFit({ facts, needs, brand: "Nike", chart: nikeChart(), charts });
    expect(fit.status).toBe("fail");
    expect(fit.summary).toMatch(/^Listed US 14 \(UK 13\) is 4 sizes bigger than your Nike size/);
  });

  it("keeps the listing's own title and price lines when scoping the page text", () => {
    const { capture } = prepareCapture(raw);
    const scoped = prepareText(capture).pageText;
    expect(scoped).toContain("Grey Nike P6000 - Men’s size 14");
    expect(scoped).toContain("£20.75");
  });

  it("sends a capture that passes the API schema", () => {
    expect(CaptureSchema.safeParse(prepareCapture(raw).capture).success).toBe(true);
  });
});

describe("Vinted: totals and verification", () => {
  const facts = () => mergeListingFacts(geminiFacts(), redactListingData(structuredListing(raw)!.listing));
  const offer = (retailer: string, priceGBP: number) => ({ retailer, priceGBP, url: `https://example.test/${retailer}`, title: `Nike P-6000 (${retailer})` });

  it("compares the total including protection and postage with the new price, and says so", async () => {
    const r = await checkPrice({
      facts: facts(),
      needs,
      model: { id: null, brand: "Nike", name: "P-6000" },
      samples: [],
      lookupNewPrices: async () => summariseOffers([offer("A", 28), offer("B", 30), offer("C", 32)], { checkedOn: "2026-11-14", query: "Nike P-6000", rawResults: 3 }),
    });
    // £20.75 alone is under the £30 new price; £31.18 with protection and postage is not.
    expect(r.details).toMatchObject({ position: "at_or_above_new", listingPriceGBP: 20.75, listingTotalGBP: 31.18, priceBasis: "£31.18 including protection and postage" });
    expect(r.summary).toContain("At £31.18 including protection and postage it costs as much as buying new");
    expect((r.details as { newOffers: { offers: { differenceGBP: number }[] } }).newOffers.offers[0].differenceGBP).toBe(-3.18);
  });

  it("warning signs use the total too", () => {
    const price = { check: "price" as const, status: "pass" as const, summary: "", evidence: [], confidence: 0.6, geminiFeatures: [], details: { listingPriceGBP: 20.75, listingTotalGBP: 31.18, priceBasis: "£31.18 including protection and postage", newPrice: { gbp: 100 } } };
    const signals = detectWarningSignals({ checks: [price], facts: { ...facts(), conditionClaims: ["Brand new"] }, identify: null, pageText: "", platform: "vinted" });
    expect(signals.find((s) => s.id === "price_far_below")?.evidence[0].label).toBe("Priced at £31.18 including protection and postage. New from UK retailers: about £100.");
  });

  it("suggests Vinted's verification before paying when verification is indicated and a warning sign fires", async () => {
    const checks = [{ check: "identify" as const, status: "pass" as const, summary: "", evidence: [], confidence: 0.9, geminiFeatures: [] }];
    const signal = { id: "price_far_below" as const, strength: "medium" as const, text: "Unusually low.", evidence: [], confidence: 0.85, relatesTo: ["price" as const] };
    const withSignal = await generateNextMoves(null, { checks, leads: [], label: "worth_a_look", signals: [signal], platform: "vinted", verificationAvailable: true });
    expect(withSignal.find((m) => m.id === "nm_platform_verification")).toMatchObject({ kind: "before_you_pay", text: expect.stringContaining("Vinted's item verification") });
    const noSignal = await generateNextMoves(null, { checks, leads: [], label: "worth_a_look", signals: [], platform: "vinted", verificationAvailable: true });
    expect(noSignal.some((m) => m.id === "nm_platform_verification")).toBe(false);
  });
});

describe("Vinted: size system not stated", () => {
  it("description edited to drop 'US': fit warns and the seller is asked 'Is that a UK or US size?'", async () => {
    const edited = collectFixture(VINTED_FIXTURE, (html) => html.replaceAll("Mens US 14", "Mens 14"));
    const { listing } = structuredListing(edited)!;
    expect(listing.description?.value).toContain("Nike P6000, Mens 14 grey runners.");
    expect(listing.sizeSystem).toBeUndefined();
    const facts = mergeListingFacts(geminiFacts(), listing);
    expect(facts.sizeSystem).toBe("unknown");
    const fit = checkFit({ facts, needs, brand: "Nike", chart: nikeChart(), charts });
    expect(fit.status).toBe("warn");
    expect(fit.summary).toMatch(/^Size system not stated: the listing says size 14 without UK, US or EU/);
    const moves = await generateNextMoves(null, { checks: [fit], leads: [], label: "proceed_with_caution", platform: "vinted" });
    expect(moves.find((m) => m.kind === "ask_seller" && m.relatesTo.includes("fit"))?.text).toBe("Is that a UK or US size?");
    raw = collectFixture(VINTED_FIXTURE); // restore the unedited page for later tests
  });
});
