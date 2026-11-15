import { afterEach, describe, expect, it } from "vitest";
import * as casesRoute from "@/app/api/cases/route";
import * as caseRoute from "@/app/api/cases/[id]/route";
import { createCase } from "@/pipeline";
import { setDeps } from "@/pipeline/deps";
import { CaseDetailSchema } from "@/schemas";
import type { ObservedAlternatives, ObservedComparison, ObservedListing } from "@/schemas/domain";
import type { StoredSurvey } from "@/lib/observed";
import { checksFrom, happyHandlers, json, makeDeps, PAGE_TEXT, PROFILE, promptText, type Handler } from "./helpers";

const ORIGIN = "chrome-extension://testextensionid";
const BASE = "http://localhost:3000";
const PAGE_URL = "https://www.vinted.co.uk/items/123-nike-pegasus";

let n = 0;
const card = (over: Partial<ObservedListing> = {}): ObservedListing => {
  n++;
  return {
    id: String(9000 + n),
    title: "Nike Pegasus 40 UK 9",
    price: 30,
    currency: "GBP",
    url: `https://www.vinted.co.uk/items/${9000 + n}-nike-pegasus-40`,
    thumbnailUrl: `https://images1.vinted.net/t/${9000 + n}/310x430/a.webp`,
    sponsored: false,
    priceBasis: "excl_buyer_protection",
    seenAt: "2026-11-14T10:00:00.000Z",
    ...over,
  };
};

const surveyCards = () => [
  card({ price: 30 }),
  card({ price: 32 }),
  card({ price: 45, title: "Nike Pegasus 40 UK 10" }),
  card({ price: 50 }),
  card({ price: 55 }),
  card({ title: "Nike Pegasus trainers", price: 20 }),
  card({ title: "Nike Pegasus 39", price: 15 }),
  card({ title: "Adidas Samba OG", price: 25 }),
  card({ id: "123", price: 1 }), // the listing being investigated
];

afterEach(() => setDeps(null));

async function investigate(deps: ReturnType<typeof makeDeps>, capture: Record<string, unknown>) {
  const { caseId, done } = await createCase(deps, {
    capture: { pageUrl: PAGE_URL, pageText: PAGE_TEXT, imageUrls: ["https://img.example.com/1.jpg"], ...capture },
    profile: PROFILE,
    screenshots: [],
  }, { pause: false }); // these tests are about the checks on a best guess, not the pause
  await done;
  return { caseId, checks: checksFrom(deps.hub.events(caseId)) };
}

describe("observed listings through the pipeline", () => {
  it("compares with the survey, stores only the matched subset, and suggests cheaper exact matches", async () => {
    const deps = makeDeps();
    const { caseId, checks } = await investigate(deps, { observedListings: surveyCards(), searchQuery: "Nike Pegasus 40" });
    const d = checks.price.details as { observedComparison: ObservedComparison; position: string };
    expect(d.observedComparison).toMatchObject({
      searchQuery: "Nike Pegasus 40",
      source: "observed_listings",
      counts: { exact: 5, version_unknown: 1, different_version: 1, none: 1, surveyed: 8, auctionsExcluded: 0 },
      stats: { n: 5, median: 45 },
    });
    // £38 listing: £30 and £32 are exact, in UK 9, and at least £5 cheaper.
    expect(d.observedComparison.suggestions.map((s) => s.priceGBP)).toEqual([30, 32]);
    expect(checks.price.evidence.find((e) => e.sourceType === "observed_listings")?.label).toBe("Compared with 5 listings from your search on 14 Nov");

    const [row] = await deps.store.getInputs(caseId, { kinds: ["observed_listings"] });
    const stored = JSON.parse(row.text!) as StoredSurvey;
    expect(stored.counts).toEqual({ exact: 5, version_unknown: 1, different_version: 1, none: 1 });
    expect(stored.listings).toHaveLength(7);
    expect(stored.listings.some((l) => l.title === "Adidas Samba OG")).toBe(false);
    expect(Object.keys(stored.listings[0]).sort()).toEqual(["id", "matchLevel", "priceGBP", "seenOn", "sponsored", "thumbnailUrl", "title", "url"]);

    setDeps(deps);
    const res = await caseRoute.GET(new Request(`${BASE}/api/cases/${caseId}`, { headers: { origin: ORIGIN } }), { params: Promise.resolve({ id: caseId }) });
    const detail = CaseDetailSchema.parse(await res.json());
    expect(detail.observedComparison?.source).toBe("observed_listings");
    expect(detail.observedComparison?.suggestions).toHaveLength(2);
  });

  it("streams and returns cheaper alternatives from the survey, never the listing itself", async () => {
    const deps = makeDeps();
    const { caseId } = await investigate(deps, { observedListings: surveyCards(), searchQuery: "Nike Pegasus 40" });
    const events = deps.hub.events(caseId);
    const altIdx = events.findIndex((e) => e.event === "observed_alternatives");
    const priceIdx = events.findIndex((e) => e.event === "check_done" && (e.data as { check: string }).check === "price");
    expect(altIdx).toBeGreaterThan(-1);
    expect(altIdx).toBeLessThan(priceIdx); // sent as soon as the survey is evaluated, before the check finishes
    const streamed = events[altIdx].data as ObservedAlternatives;
    // £38 listing: £30 and £32 exact in UK 9, then "Nike Pegasus trainers" (£20, version and size not stated).
    // Not the UK 10 pair, Pegasus 39, the Samba, or the listing itself (£1).
    expect(streamed.alternatives.map((a) => [a.priceGBP, a.matchLevel, a.size])).toEqual([
      [30, "exact", "UK 9"],
      [32, "exact", "UK 9"],
      [20, "version_unknown", null],
    ]);
    expect(streamed.alternatives.every((a) => a.listingId !== "123" && a.differenceGBP < 0 && a.priceBasis === "listed" && a.colourMatch !== ("different" as string))).toBe(true);

    setDeps(deps);
    const res = await caseRoute.GET(new Request(`${BASE}/api/cases/${caseId}`, { headers: { origin: ORIGIN } }), { params: Promise.resolve({ id: caseId }) });
    const detail = CaseDetailSchema.parse(await res.json());
    expect(detail.observedAlternatives).toEqual(streamed);
    expect(detail.observedAlternatives).toMatchObject({ surveyUsed: true, platform: "vinted", surveyedOn: "2026-11-14" });
  });

  it("without a survey: alternatives [] and surveyUsed false", async () => {
    const deps = makeDeps();
    const { caseId } = await investigate(deps, {});
    setDeps(deps);
    const res = await caseRoute.GET(new Request(`${BASE}/api/cases/${caseId}`, { headers: { origin: ORIGIN } }), { params: Promise.resolve({ id: caseId }) });
    const detail = CaseDetailSchema.parse(await res.json());
    expect(detail.observedAlternatives).toEqual({ surveyUsed: false, platform: null, surveyedOn: null, alternatives: [] });
    expect(deps.hub.events(caseId).find((e) => e.event === "observed_alternatives")?.data).toEqual(detail.observedAlternatives);
  });

  it("says it couldn't compare when only the brand is known", async () => {
    const deps = makeDeps({
      handlers: {
        identify: () => json({ brand: "Nike", brandConfidence: 0.9, modelName: null, catalogueModelId: null, confidence: 0, reasons: "No model shown", evidence: [] }),
      },
    });
    const { checks } = await investigate(deps, { observedListings: surveyCards() });
    expect(checks.price.status).toBe("unknown");
    expect((checks.price.details as { observedComparison: ObservedComparison }).observedComparison).toMatchObject({ note: "Couldn't compare: model unknown.", source: "none", suggestions: [] });
    expect((checks.price.details as { observedAlternatives: ObservedAlternatives }).observedAlternatives).toMatchObject({ surveyUsed: true, alternatives: [] });
  });

  it("Pro disagrees: possible, Pro's answer is the best guess and Flash's the alternative", async () => {
    const PAGE = "Nike running trainers\nSize: UK 9\n£38.00\nCondition: Very good";
    const flash = { brand: "Nike", brandConfidence: 0.95, modelName: "Pegasus 40", catalogueModelId: "nike-pegasus-40", confidence: 0.9, reasons: "Tongue label", evidence: [] };
    const base = happyHandlers();
    const handlers: Record<string, Handler> = {
      extract: async (req) => json({ ...JSON.parse((await base.extract(req)).text), title: "Nike running trainers", modelText: null, evidence: [{ field: "price", kind: "quote", quote: "£38.00" }] }),
      identify: (req) => (req.tier === "strong" ? json({ ...flash, modelName: "Pegasus 41", catalogueModelId: "nike-pegasus-41" }) : json(flash)),
    };
    const deps = makeDeps({ handlers, webSearch: {} });
    const { caseId, checks } = await investigate(deps, { pageText: PAGE, imageUrls: ["https://img.example.com/1.jpg", "https://img.example.com/2.jpg"], observedListings: surveyCards() });
    expect(checks.identify.details).toMatchObject({ tier: "catalogue", level: "possible", modelName: "Nike Pegasus 41" });
    expect((await deps.store.getCase(caseId))!.identify).toMatchObject({ confidenceLevel: "possible", alternatives: [{ model: "Pegasus 40" }] });
  });

  it("sends the search as a marked hint, and a model only the search names stays below likely", async () => {
    const PAGE = "Nike running trainers\nSize: UK 9\n£38.00\nCondition: Very good";
    const base = happyHandlers();
    const handlers: Record<string, Handler> = {
      extract: async (req) => json({ ...JSON.parse((await base.extract(req)).text), title: "Nike running trainers", modelText: null, evidence: [{ field: "price", kind: "quote", quote: "£38.00" }] }),
      // The model guesses the model from the search alone, with high confidence and no photo evidence.
      identify: () => json({ brand: "Nike", brandConfidence: 0.95, modelName: "Pegasus 40", catalogueModelId: "nike-pegasus-40", confidence: 0.95, reasons: "Search says so", evidence: [] }),
    };
    const deps = makeDeps({ handlers });
    const { caseId, checks } = await investigate(deps, { pageText: PAGE, searchQuery: "nike pegasus 40" });
    const extract = deps.calls.find((c) => c.stage === "extract")!;
    expect(promptText(extract)).toContain(`HINT, the user's own search (NOT a fact about this listing): the user found this listing by searching "nike pegasus 40"`);
    expect(checks.identify.details).toMatchObject({ level: "possible" });
    expect((await deps.store.getCase(caseId))!.identify!.confidence).toBeLessThan(0.75);

    // Without the search, the prompt has no hint.
    const plain = makeDeps({ handlers });
    await investigate(plain, { pageText: PAGE });
    expect(promptText(plain.calls.find((c) => c.stage === "extract")!)).not.toContain("HINT, the user's own search");
  });
});

describe("POST /api/cases with observed listings", () => {
  const form = (capture: object) => {
    const f = new FormData();
    f.set("capture", JSON.stringify(capture));
    f.set("profile", JSON.stringify(PROFILE));
    return f;
  };
  const post = (capture: object) => casesRoute.POST(new Request(`${BASE}/api/cases`, { method: "POST", body: form(capture), headers: { origin: ORIGIN } }));

  it("accepts up to 300 listings and rejects more", async () => {
    setDeps(makeDeps());
    const ok = await post({ pageUrl: PAGE_URL, pageText: PAGE_TEXT, observedListings: Array.from({ length: 300 }, () => card()), searchQuery: "pegasus" });
    expect(ok.status).toBe(201);
    const tooMany = await post({ pageUrl: PAGE_URL, pageText: PAGE_TEXT, observedListings: Array.from({ length: 301 }, () => card()) });
    expect(tooMany.status).toBe(400);
  });

  it("validates each listing and strips anything that isn't a card fact", async () => {
    setDeps(makeDeps());
    const bad = await post({ pageUrl: PAGE_URL, pageText: PAGE_TEXT, observedListings: [{ ...card(), url: "javascript:alert(1)" }] });
    expect(bad.status).toBe(400);
    const { ObservedListingSchema } = await import("@/schemas/domain");
    const parsed = ObservedListingSchema.parse({ ...card(), seller: "jane_doe_99", sellerRating: 4.9, location: "Leeds" });
    expect(parsed).not.toHaveProperty("seller");
    expect(parsed).not.toHaveProperty("sellerRating");
    expect(parsed).not.toHaveProperty("location");
  });
});
