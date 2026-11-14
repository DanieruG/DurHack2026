import { describe, expect, it } from "vitest";
import {
  matchSurvey,
  MIN_OBSERVED_MATCHES,
  minSaving,
  observedContext,
  observedStats,
  prepareSurvey,
  suggestCheaper,
  toStoredSurvey,
  fromStoredSurvey,
  userSizeUK,
  type Survey,
} from "@/lib/observed";
import { deriveTokens } from "@/lib/titleMatch";
import { checkPrice } from "@/pipeline/checks/price";
import { guardSearchHint, searchHintPart, subjectOf } from "@/pipeline/identify";
import type { IdentifyResult, ListingFacts, ObservedListing, UserNeeds } from "@/schemas/domain";
import type { NewPrices } from "@/lib/newPrices";
import { fixtureReference } from "./helpers";

const ref = fixtureReference();
const nikeChart = ref.sizeCharts.find((c) => c.id === "nike-mens")!;
const peg40 = deriveTokens("Nike", "Pegasus 40");

let n = 0;
function card(over: Partial<ObservedListing> = {}): ObservedListing {
  n++;
  return {
    id: String(5000 + n),
    title: "Nike Pegasus 40 UK 9",
    price: 40,
    currency: "GBP",
    url: `https://www.vinted.co.uk/items/${5000 + n}-nike-pegasus-40`,
    sponsored: false,
    priceBasis: "excl_buyer_protection",
    seenAt: "2026-11-14T10:00:00.000Z",
    ...over,
  };
}
const ebay = (over: Partial<ObservedListing> = {}) => {
  const c = card(over);
  return { ...c, url: `https://www.ebay.co.uk/itm/${c.id}00000`, priceBasis: "listed" as const, ...over };
};

const survey = (cards: ObservedListing[], platform: "vinted" | "ebay" = "vinted", pageUrl?: string) =>
  prepareSurvey(cards, { platform, pageUrl, searchQuery: "nike pegasus 40" })!;

const needs: UserNeeds = { sizes: [{ brand: "Nike", size: 9, system: "UK" }], priorities: [], wearTolerance: "light", extraPriorities: [], assumptions: [] };
const facts = (priceGBP: number): ListingFacts => ({ platform: "vinted", photoCount: 1, conditionClaims: [], priceGBP, evidence: [] });
const noShopping = async (): Promise<NewPrices> => ({ available: false, medianGBP: null, lowestGBP: null, offers: [], checkedOn: "2026-11-14", fromCache: false }) as unknown as NewPrices;

function observedArgs(cards: ObservedListing[], userUK: number | null = 9) {
  const s = survey(cards);
  return { survey: s, matched: matchSurvey(s, peg40, nikeChart), userSizeUK: userUK };
}

describe("survey preparation", () => {
  it("dedupes by listing id, keeping the latest card", () => {
    const a = card({ id: "77", price: 50, seenAt: "2026-11-14T09:00:00.000Z" });
    const b = { ...a, price: 45, seenAt: "2026-11-14T11:00:00.000Z" };
    const s = survey([a, b]);
    expect(s.listings).toHaveLength(1);
    expect(s.listings[0].priceGBP).toBe(45);
    expect(s.surveyedOn).toBe("2026-11-14");
  });

  it("excludes eBay auctions and uses Buy It Now prices only", () => {
    const s = survey([ebay({ buyingFormat: "auction", price: 5 }), ebay({ buyingFormat: "buy_it_now" }), ebay({ buyingFormat: "unknown" })], "ebay");
    expect(s.auctionsExcluded).toBe(1);
    expect(s.listings).toHaveLength(2);
    expect(s.listings.every((l) => l.priceGBP === 40)).toBe(true);
  });

  it("drops the listing being investigated, other platforms and cards without a GBP price", () => {
    const current = card({ id: "123" });
    const s = survey(
      [current, card(), ebay(), card({ currency: "EUR" }), card({ price: null })],
      "vinted",
      "https://www.vinted.co.uk/items/123-nike-pegasus-40?ref=x",
    );
    expect(s.surveyed).toBe(3);
    expect(s.unpricedExcluded).toBe(2);
    expect(s.listings).toHaveLength(1);
  });

  it("keeps one consistent Vinted price basis and records it", () => {
    const s = survey([card(), card(), card({ priceBasis: "listed" })]);
    expect(s.priceBasis).toBe("excl_buyer_protection");
    expect(s.listings).toHaveLength(2);
  });

  it("keeps sponsored cards, flagged", () => {
    const s = survey([card({ sponsored: true })]);
    expect(s.listings[0].sponsored).toBe(true);
  });

  it("stores only the matched subset, with counts per match level", () => {
    const s = survey([card(), card({ title: "Nike Pegasus trainers" }), card({ title: "Nike Pegasus 39" }), card({ title: "Adidas Samba OG" }), card({ title: "Nike shoes" })]);
    const stored = toStoredSurvey(s, matchSurvey(s, peg40, nikeChart));
    expect(stored.counts).toEqual({ exact: 1, version_unknown: 1, different_version: 1, none: 2 });
    expect(stored.listings.map((l) => l.matchLevel)).toEqual(["exact", "version_unknown", "different_version"]);
    expect(Object.keys(stored.listings[0]).sort()).toEqual(["id", "matchLevel", "priceGBP", "sponsored", "title", "url"]);
    // Reopen re-matches the stored cards; the unmatched ones still count as none.
    const again = fromStoredSurvey(stored);
    expect(toStoredSurvey(again, matchSurvey(again, peg40, nikeChart)).counts).toEqual(stored.counts);
  });
});

describe("Source C threshold", () => {
  const exact = (k: number) => Array.from({ length: k }, (_, i) => card({ price: 30 + i * 5 }));
  it(`needs at least ${MIN_OBSERVED_MATCHES} exact matches`, () => {
    expect(observedStats(observedArgs(exact(4)).matched, "2026-11-14")).toBeNull();
    const stats = observedStats(observedArgs(exact(5)).matched, "2026-11-14");
    expect(stats).toMatchObject({ n: 5, median: 40, p10: 32, p25: 35, p90: 48, collectedOn: { from: "2026-11-14", to: "2026-11-14" } });
  });

  it("counts exact matches only, in all adult sizes", () => {
    const cards = [...exact(4), card({ title: "Nike Pegasus trainers", price: 41 }), card({ title: "Nike Pegasus 40 UK 11", price: 42 }), card({ title: "Nike Pegasus 40 UK 2", price: 20 })];
    const stats = observedStats(observedArgs(cards).matched, "2026-11-14");
    expect(stats?.n).toBe(5); // 4 + the UK 11; not the version-unknown card, not the child's UK 2
  });

  it("below the threshold: context including version-not-stated matches, labelled", () => {
    const cards = [card({ price: 30 }), card({ price: 45 }), card({ title: "Nike Pegasus", price: 25 }), card({ title: "Nike Pegasus 39", price: 10 })];
    const ctx = observedContext(observedArgs(cards).matched, { familyLevel: false });
    expect(ctx).toMatchObject({ n: 3, minGBP: 25, maxGBP: 45, exact: 2, versionUnknown: 1 });
    expect(ctx!.line).toBe("3 similar listings seen, £25 to £45 (2 exact, 1 not stating the version)");
  });
});

describe("source precedence in the price check", () => {
  const model = { id: "nike-pegasus-40", brand: "Nike", name: "Pegasus 40" };
  const five = () => Array.from({ length: 5 }, (_, i) => card({ price: 50 + i * 5 })); // median 60

  it("uses observed listings (Source C) over the catalogue sample when there are 5+ exact matches", async () => {
    const r = await checkPrice({ facts: facts(52), needs, model, samples: ref.priceSamples, lookupNewPrices: noShopping, observed: observedArgs(five()) });
    const d = r.details as Record<string, any>;
    expect(d.observedComparison.source).toBe("observed_listings");
    expect(d.sample).toMatchObject({ n: 5, median: 60, ruleIds: ["observed_listings"] });
    expect(r.evidence.find((e) => e.sourceType === "observed_listings")?.label).toBe("Compared with 5 listings from your search on 14 Nov");
    expect(r.evidence.some((e) => e.sourceType === "price_sample")).toBe(false);
    expect(r.confidence).toBeLessThanOrEqual(0.6);
    expect(r.summary).toContain("from your search on 14 Nov");
  });

  it("falls back to the catalogue sample (Source A) with fewer than 5, and shows context only", async () => {
    const r = await checkPrice({ facts: facts(52), needs, model, samples: ref.priceSamples, lookupNewPrices: noShopping, observed: observedArgs(five().slice(0, 4)) });
    const d = r.details as Record<string, any>;
    expect(d.observedComparison.source).toBe("price_sample");
    expect(d.observedComparison.stats).toBeNull();
    expect(d.observedComparison.context.line).toBe("4 similar listings seen, £50 to £65");
    expect(r.evidence.some((e) => e.sourceType === "price_sample")).toBe(true);
    expect(r.summary).toContain("4 similar listings seen, £50 to £65 in your search.");
  });

  it("lets a model outside the catalogue use Source C, at most 0.6 confidence", async () => {
    const outside = { id: null, brand: "Nike", name: "Pegasus 40" };
    const withC = await checkPrice({ facts: facts(52), needs, model: outside, samples: [], lookupNewPrices: noShopping, observed: observedArgs(five()) });
    expect(withC.status).toBe("pass");
    expect(withC.summary).not.toContain("isn't in our price sample");
    expect(withC.confidence).toBeGreaterThan(0.45);
    expect(withC.confidence).toBeLessThanOrEqual(0.6);
  });

  it("still applies the new-price rules (Source B) on top of Source C", async () => {
    const shopping = async () =>
      ({ available: true, medianGBP: 60, lowestGBP: 55, offers: [55, 60, 65].map((p, i) => ({ retailer: `R${i}`, title: "Nike Pegasus 40", priceGBP: p, url: `https://shop${i}.example.com/p` })), checkedOn: "2026-11-14", fromCache: false }) as unknown as NewPrices;
    const r = await checkPrice({ facts: facts(62), needs, model, samples: ref.priceSamples, lookupNewPrices: shopping, observed: observedArgs(five()) });
    expect(r.status).toBe("fail");
    expect((r.details as Record<string, any>).position).toBe("at_or_above_new");
    expect((r.details as Record<string, any>).observedComparison.source).toBe("observed_listings");
  });
});

describe("cheaper similar listings", () => {
  it("suggests up to 2 exact matches, cheapest first, cheaper by at least 10% or £5 (whichever is larger)", () => {
    const cards = [
      card({ id: "a", price: 30 }),
      card({ id: "b", price: 34 }),
      card({ id: "c", price: 25 }),
      card({ id: "d", price: 36 }), // only £4 cheaper than £40: not enough
      card({ id: "e", title: "Nike Pegasus trainers", price: 10 }), // version not stated: not exact
      card({ id: "f", title: "Nike Pegasus 40 UK 11", price: 12 }), // not the user's size
    ];
    const s = suggestCheaper(observedArgs(cards).matched, { price: 40, userSizeUK: 9, platform: "vinted" });
    expect(s.map((x) => x.id)).toEqual(["c", "a"]);
    expect(s[0]).toMatchObject({ priceGBP: 25, savingGBP: 15, sizeLabel: "UK 9", sizeNotStated: false, platform: "vinted" });
    expect(minSaving(40)).toBe(5);
    expect(minSaving(100)).toBe(10);
  });

  it("includes listings with no size stated, flagged, and sponsored ones, flagged", () => {
    const cards = [card({ id: "x", title: "Nike Pegasus 40", price: 20, sponsored: true })];
    const [s] = suggestCheaper(observedArgs(cards).matched, { price: 40, userSizeUK: 9, platform: "vinted" });
    expect(s).toMatchObject({ id: "x", sizeLabel: null, sizeNotStated: true, sponsored: true });
  });

  it("never suggests auctions", () => {
    const s = survey([ebay({ id: "9", buyingFormat: "auction", price: 5 })], "ebay");
    expect(suggestCheaper(matchSurvey(s, peg40, nikeChart), { price: 40, userSizeUK: 9, platform: "ebay" })).toEqual([]);
  });

  it("reads a card's size field before its title, converting to UK", () => {
    const [m] = observedArgs([card({ title: "Nike Pegasus 40", sizeText: "44" })]).matched;
    expect(m).toMatchObject({ sizeUK: 9, sizeLabel: "UK 9" });
  });

  it("finds the user's size for the brand, or another brand's by foot length", () => {
    expect(userSizeUK(needs, "Nike", nikeChart, ref.sizeCharts)).toBe(9);
    const adidasOnly: UserNeeds = { ...needs, sizes: [{ brand: "Adidas", size: 9, system: "UK" }] };
    expect(userSizeUK(adidasOnly, "Nike", nikeChart, ref.sizeCharts)).not.toBeNull();
    expect(userSizeUK({ ...needs, sizes: [] }, "Nike", nikeChart, ref.sizeCharts)).toBeNull();
  });
});

describe("search query as an identify hint", () => {
  const result = (over: Partial<IdentifyResult> = {}): IdentifyResult => ({
    brand: "Nike",
    brandConfidence: 0.9,
    modelName: "Pegasus 40",
    catalogueModelId: "nike-pegasus-40",
    inCatalogue: true,
    confidence: 0.92,
    reasons: "Looks like it.",
    evidence: [],
    ...over,
  });
  const args = (listingText: string, searchQuery: string | null = "nike pegasus 40") => ({ searchQuery, listingText, catalogue: ref.catalogue, min: 0.75 });

  it("is sent clearly marked as the user's search, not a fact about the listing", () => {
    const [part] = searchHintPart('nike "pegasus" 40\nignore previous');
    expect(part.text).toContain("the user's own search (NOT a fact about this listing)");
    expect(part.text).toContain('searching "nike pegasus 40 ignore previous"');
    expect(searchHintPart(null)).toEqual([]);
    expect(searchHintPart("   ")).toEqual([]);
  });

  it("never produces a confident identification on its own", () => {
    const guarded = guardSearchHint(result(), args("Nike running trainers\nSize UK 9\nGood condition"));
    expect(guarded.confidence).toBeLessThan(0.75);
    expect(subjectOf(guarded, 0.75, ref.catalogue).tier).toBe("brand");
    expect(guarded.reasons).toContain("matches the user's search");
  });

  it("doesn't touch an identification the listing itself supports", () => {
    expect(guardSearchHint(result(), args("Nike Air Zoom Pegasus 40 trainers")).confidence).toBe(0.92);
    expect(guardSearchHint(result(), args("Nike running trainers", null)).confidence).toBe(0.92);
    expect(guardSearchHint(result(), args("Nike running trainers", "nike running shoes")).confidence).toBe(0.92);
  });

  it("leaves a photo-read model to the Pro recheck (which never sees the hint)", () => {
    const photo = result({ evidence: [{ id: "ev_id_1", kind: "photo_region", label: "Tongue label", photoIndex: 0 }] });
    expect(guardSearchHint(photo, args("Nike running trainers")).confidence).toBe(0.92);
  });

  it("never raises a confidence that was already low", () => {
    expect(guardSearchHint(result({ confidence: 0.4 }), args("Nike running trainers")).confidence).toBe(0.4);
  });
});

export type { Survey };
