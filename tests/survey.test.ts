// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  cardFromDom,
  cardsFromCapture,
  cardsFromEmbedded,
  collectSearchResults,
  mergeSurvey,
  MAX_SURVEY_CARDS,
  normaliseQuery,
  parsePrice,
  parseVintedSummary,
  pruneSurveys,
  scanUrlOf,
  queryModel,
  searchPageOf,
  summariseSurvey,
  summaryLine,
  surveyForCase,
  SURVEY_TTL_MS,
  type RawSearchCard,
  type SurveyCard,
  type SurveyRecord,
} from "@/extension/src/lib/survey";
import { observedView } from "@/extension/src/lib/evidence";
import { OBSERVED } from "@/extension/src/preview/fixtures";
import { ObservedListingSchema } from "@/schemas/domain";

const NOW = Date.parse("2026-11-14T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const setPage = (url: string, html: string) => {
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(url);
  document.body.innerHTML = html;
};
const SELLER = /jane_doe|98\.5%|1,204|united kingdom|from leeds|trainerfan/i;

describe("search pages", () => {
  it("recognises eBay and Vinted search results and normalises the query", () => {
    expect(searchPageOf("https://www.ebay.co.uk/sch/i.html?_nkw=Nike+Pegasus+40&_sacat=0")).toEqual({ platform: "ebay", query: "nike pegasus 40", key: "ebay:nike pegasus 40" });
    expect(searchPageOf("https://www.vinted.co.uk/catalog?search_text=Pegasus%2040!&order=newest_first")).toEqual({ platform: "vinted", query: "pegasus 40", key: "vinted:pegasus 40" });
    // A category page with no search words is its own survey, not one shared by every category.
    expect(searchPageOf("https://www.vinted.co.uk/catalog/1231-mens-trainers")?.key).toBe("vinted::/catalog/1231-mens-trainers");
    expect(searchPageOf("https://www.vinted.co.uk/catalog/5-womens-boots")?.key).not.toBe(searchPageOf("https://www.vinted.co.uk/catalog/1231-mens-trainers")?.key);
    expect(searchPageOf("https://www.ebay.co.uk/sch/i.html?_sacat=15709&_nkw=")?.key).toBe("ebay::15709");
    expect(searchPageOf("https://www.ebay.co.uk/itm/1234567890")).toBeNull();
    expect(searchPageOf("https://www.vinted.co.uk/items/123-nike")).toBeNull();
    expect(searchPageOf("https://www.depop.com/search/?q=nike")).toBeNull();
    expect(searchPageOf("http://www.ebay.co.uk/sch/i.html?_nkw=x")).toBeNull();
    expect(normaliseQuery("  Nike  Air-Max 90 ")).toBe("nike air max 90");
  });
});

const EBAY_HTML = `
<ul class="srp-results">
  <li class="s-item"><a href="https://www.ebay.co.uk/itm/123456?hash=x"><span class="s-item__title">Shop on eBay</span></a></li>
  <li class="s-item">
    <a class="s-item__link" href="https://www.ebay.co.uk/itm/2000000001?hash=item1&var=0"><div class="s-item__title"><span>New listing</span>Nike Air Zoom Pegasus 40 UK 9 Black</div></a>
    <img src="https://i.ebayimg.com/thumbs/images/g/abc/s-l500.webp" />
    <div class="s-item__subtitle"><span class="SECONDARY_INFO">Pre-owned</span> · UK Shoe Size: 9</div>
    <span class="s-item__price">£35.00</span>
    <span class="s-item__purchase-options">Buy it now</span>
    <span class="s-item__seller-info-text">jane_doe_99 (1,204) 98.5%</span>
    <span class="s-item__location">from Leeds, United Kingdom</span>
  </li>
  <li class="s-item">
    <a class="s-item__link" href="https://www.ebay.co.uk/itm/2000000002"><div class="s-item__title">Nike Pegasus 40 size 10</div></a>
    <span class="s-item__price">£12.50</span>
    <span class="s-item__bids">3 bids</span> <span class="s-item__time-left">Time left 1d 2h</span>
  </li>
  <li class="s-card" data-listingid="2000000003">
    <a href="https://www.ebay.co.uk/itm/nike-pegasus-41/2000000003"><span class="s-card__title">Nike Pegasus 41 Opens in a new window or tab</span></a>
    <div class="s-card__subtitle">Brand new</div>
    <span class="s-card__price">£20.00 to £30.00</span>
    <span class="s-item__detail--primary">Sponsored</span>
  </li>
</ul>`;

const VINTED_HTML = `
<div class="feed-grid">
  <div class="feed-grid__item"><div data-testid="product-item-id-555">
    <a href="https://www.vinted.co.uk/items/555-nike-pegasus-40?referrer=catalog" title="Nike Pegasus 40, brand: Nike, condition: Very good, size: 43, £28.00, £30.10 includes Buyer Protection"></a>
    <img src="https://images1.vinted.net/t/01_abc/310x430/x.webp?s=1" />
    <p data-testid="product-item-id-555--price-text">£28.00</p>
    <span class="seller">trainerfan99</span>
  </div></div>
  <div class="feed-grid__item"><div data-testid="product-item-id-556">
    <a href="https://www.vinted.co.uk/items/556-pegasus" title="Pegasus trainers, brand: Nike, condition: Good, £15.00, £16.45 includes Buyer Protection"></a>
    <div data-testid="product-item-id-556--overlay">Bumped</div>
  </div></div>
</div>`;

describe("in-page collector (card fields only)", () => {
  it("reads eBay cards: Buy It Now vs auction, sponsored, condition, size; never the seller or location", () => {
    setPage("https://www.ebay.co.uk/sch/i.html?_nkw=nike+pegasus+40", EBAY_HTML);
    const raw = collectSearchResults();
    expect(raw.cards.map((c) => c.title)).toEqual(["Nike Air Zoom Pegasus 40 UK 9 Black", "Nike Pegasus 40 size 10", "Nike Pegasus 41"]);
    expect(raw.cards.map((c) => c.format)).toEqual(["buy_it_now", "auction", "unknown"]);
    expect(raw.cards[0]).toMatchObject({ condition: "Pre-owned", sizeText: "UK Shoe Size: 9", priceText: "£35.00", sponsored: false });
    expect(raw.cards[2]).toMatchObject({ condition: "Brand new", sponsored: true });
    expect(JSON.stringify(raw)).not.toMatch(SELLER);

    const cards = cardsFromCapture(raw, "ebay", iso(0));
    expect(cards.map((c) => [c.id, c.url, c.price, c.buyingFormat])).toEqual([
      ["2000000001", "https://www.ebay.co.uk/itm/2000000001", 35, "buy_it_now"],
      ["2000000002", "https://www.ebay.co.uk/itm/2000000002", 12.5, "auction"],
      ["2000000003", "https://www.ebay.co.uk/itm/2000000003", null, "unknown"], // a price range has no single price
    ]);
    expect(cards[0].thumbnailUrl).toBe("https://i.ebayimg.com/thumbs/images/g/abc/s-l500.webp");
    for (const c of cards) expect(ObservedListingSchema.safeParse(c).success).toBe(true);
  });

  it("reads Vinted cards with the price without buyer protection, and flags bumped ones", () => {
    setPage("https://www.vinted.co.uk/catalog?search_text=pegasus", VINTED_HTML);
    const raw = collectSearchResults();
    expect(JSON.stringify(raw.cards)).not.toMatch(SELLER);
    const cards = cardsFromCapture(raw, "vinted", iso(0));
    expect(cards).toHaveLength(2);
    expect(cards[0]).toMatchObject({ id: "555", title: "Nike Pegasus 40", price: 28, currency: "GBP", sizeText: "43", condition: "Very good", sponsored: false, priceBasis: "excl_buyer_protection", url: "https://www.vinted.co.uk/items/555-nike-pegasus-40" });
    expect(cards[1]).toMatchObject({ id: "556", price: 15, sponsored: true });
  });
});

describe("card parsing", () => {
  it("parses prices", () => {
    expect(parsePrice("£35.00")).toEqual({ price: 35, currency: "GBP" });
    expect(parsePrice("£1,250.00")).toEqual({ price: 1250, currency: "GBP" });
    expect(parsePrice("30,00 €")).toEqual({ price: 30, currency: "EUR" });
    expect(parsePrice("£20.00 to £30.00")).toEqual({ price: null, currency: null });
    expect(parsePrice("")).toEqual({ price: null, currency: null });
  });

  it("parses Vinted's card summary, keeping the item price", () => {
    expect(parseVintedSummary("Nike Pegasus 40, brand: Nike, condition: Very good, size: 43, £28.00, £30.10 includes Buyer Protection")).toEqual({
      title: "Nike Pegasus 40",
      condition: "Very good",
      size: "43",
      priceText: "£28.00",
    });
  });

  it("prefers Vinted's embedded page data and keeps card fields only (never the seller)", () => {
    const item = {
      id: 777,
      title: "Nike Pegasus 40 UK 9",
      url: "https://www.vinted.co.uk/items/777-nike-pegasus-40",
      price: { amount: "31.0", currency_code: "GBP" },
      total_item_price: { amount: "33.25", currency_code: "GBP" },
      size_title: "UK 9",
      status: "Very good",
      is_promoted: true,
      photo: { url: "https://images1.vinted.net/t/02/f800/x.webp?s=2", thumbnails: [{ type: "thumb310x430", url: "https://images1.vinted.net/t/02/310x430/x.webp?s=3" }] },
      user: { login: "jane_doe_99", feedback_reputation: 0.98, city: "Leeds" },
    };
    const flight = `1f:${JSON.stringify({ catalogItems: { items: [item] } })}\n`;
    const scripts = [`self.__next_f.push(${JSON.stringify([1, flight])})`];
    const [c] = cardsFromEmbedded({ json: [], scripts }, "https://www.vinted.co.uk/catalog?search_text=pegasus", iso(0));
    expect(c).toMatchObject({ id: "777", price: 31, currency: "GBP", sizeText: "UK 9", condition: "Very good", sponsored: true, thumbnailUrl: "https://images1.vinted.net/t/02/310x430/x.webp?s=3" });
    expect(JSON.stringify(c)).not.toMatch(/jane_doe|leeds|feedback/i);
    // Page data wins over the card element for the same listing.
    const dom: RawSearchCard = { href: "https://www.vinted.co.uk/items/777-x", title: "Pegasus", priceText: "£99.00", img: null, sizeText: null, condition: null, sponsored: false, format: "unknown", summary: null };
    const merged = cardsFromCapture({ pageUrl: "https://www.vinted.co.uk/catalog", cards: [dom], embedded: { json: [], scripts } }, "vinted", iso(0));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ price: 31, title: "Nike Pegasus 40 UK 9" });
  });

  it("drops cards without a listing id or with an unsafe URL", () => {
    const base: RawSearchCard = { href: "https://www.ebay.co.uk/itm/2000000009", title: "Nike", priceText: "£1", img: "http://insecure/x.jpg", sizeText: null, condition: null, sponsored: false, format: "unknown", summary: null };
    expect(cardFromDom({ ...base, href: "https://www.ebay.co.uk/b/nike" }, "ebay", iso(0))).toBeNull();
    expect(cardFromDom({ ...base, href: "javascript:alert(1)" }, "ebay", iso(0))).toBeNull();
    expect(cardFromDom(base, "ebay", iso(0))?.thumbnailUrl).toBeUndefined();
  });
});

const mk = (id: string, seenAt: string, over: Partial<SurveyCard> = {}): SurveyCard => ({
  id,
  title: "Nike Pegasus 40 UK 9",
  price: 30,
  currency: "GBP",
  url: `https://www.vinted.co.uk/items/${id}-nike`,
  sponsored: false,
  priceBasis: "excl_buyer_protection",
  seenAt,
  ...over,
});
const page = searchPageOf("https://www.vinted.co.uk/catalog?search_text=nike+pegasus+40")!;

describe("local survey cache", () => {
  it("merges a repeat survey into the same search and dedupes by listing id", () => {
    const first = mergeSurvey([], page, [mk("1", iso(60_000)), mk("2", iso(60_000))], NOW - 60_000);
    expect(first.added).toBe(2);
    const second = mergeSurvey(first.surveys, page, [mk("2", iso(0), { price: 25 }), mk("3", iso(0))], NOW);
    expect(second.added).toBe(1);
    expect(second.surveys).toHaveLength(1);
    expect(second.survey!.cards.map((c) => [c.id, c.price])).toEqual([["1", 30], ["2", 25], ["3", 30]]);
    expect(second.survey!.createdAt).toBe(first.survey!.createdAt);
  });

  it("ages each card out after 24 hours, so a search you keep reading stays fresh and what left the page goes", () => {
    const old: SurveyRecord = { key: "vinted:old", platform: "vinted", query: "old", createdAt: iso(SURVEY_TTL_MS * 3), updatedAt: iso(SURVEY_TTL_MS + 5), cards: [mk("9", iso(SURVEY_TTL_MS + 1))] };
    const fresh: SurveyRecord = { ...old, key: "vinted:new", cards: [mk("1", iso(SURVEY_TTL_MS - 1000)), mk("2", iso(SURVEY_TTL_MS + 1000))] };
    const out = pruneSurveys([old, fresh], NOW);
    expect(out.map((s) => s.key)).toEqual(["vinted:new"]);
    expect(out[0].cards.map((c) => c.id)).toEqual(["1"]); // the old card goes, the survey (created long ago) stays
  });

  it("reading the same results page again REPLACES the cards; another page of the search is merged", () => {
    const url = "https://www.vinted.co.uk/catalog?search_text=nike+pegasus+40";
    const first = mergeSurvey([], page, [mk("1", iso(60_000)), mk("2", iso(60_000)), mk("recent", iso(60_000))], NOW - 60_000, scanUrlOf(url));
    const again = mergeSurvey(first.surveys, page, [mk("1", iso(0)), mk("3", iso(0))], NOW, scanUrlOf(`${url}&referrer=x`)); // tracking params don't make a new page
    expect(again.survey!.cards.map((c) => c.id)).toEqual(["1", "3"]); // "2" and "recent" are gone
    expect(again.added).toBe(1);
    const nextPage = mergeSurvey(again.surveys, page, [mk("4", iso(0))], NOW, scanUrlOf(`${url}&page=2`));
    expect(nextPage.survey!.cards.map((c) => c.id)).toEqual(["1", "3", "4"]);
    expect(scanUrlOf(`${url}&order=price_low_to_high`)).not.toBe(scanUrlOf(url));
    expect(scanUrlOf("https://www.ebay.co.uk/sch/i.html?_nkw=x&_trksid=p1&_sacat=0")).toBe(scanUrlOf("https://www.ebay.co.uk/sch/i.html?_sacat=0&_nkw=x"));
  });

  it("keeps at most 300 cards in total, dropping the oldest first", () => {
    const a: SurveyRecord = { key: "ebay:a", platform: "ebay", query: "a", createdAt: iso(5000), updatedAt: iso(5000), cards: Array.from({ length: 200 }, (_, i) => mk(`a${i}`, iso(5000 - i))) };
    const b: SurveyRecord = { key: "vinted:b", platform: "vinted", query: "b", createdAt: iso(1000), updatedAt: iso(1000), cards: Array.from({ length: 200 }, (_, i) => mk(`b${i}`, iso(1000 - i))) };
    const out = pruneSurveys([a, b], NOW);
    expect(out.flatMap((s) => s.cards)).toHaveLength(MAX_SURVEY_CARDS);
    expect(out.find((s) => s.key === "vinted:b")!.cards).toHaveLength(200);
    expect(out.find((s) => s.key === "ebay:a")!.cards.map((c) => c.id)).toEqual(Array.from({ length: 100 }, (_, i) => `a${100 + i}`));
  });

  it("sends the most recent unexpired survey for the same platform, without the listing being investigated", () => {
    const older: SurveyRecord = { key: "vinted:x", platform: "vinted", query: "x", createdAt: iso(9000), updatedAt: iso(9000), cards: [mk("1", iso(9000))] };
    const newer: SurveyRecord = { key: "vinted:nike pegasus 40", platform: "vinted", query: "nike pegasus 40", createdAt: iso(5000), updatedAt: iso(2000), cards: [mk("2", iso(2000)), mk("3", iso(2000))] };
    const other: SurveyRecord = { key: "ebay:y", platform: "ebay", query: "y", createdAt: iso(100), updatedAt: iso(100), cards: [mk("4", iso(100))] };
    const s = surveyForCase([older, newer, other], { platform: "vinted", pageUrl: "https://www.vinted.co.uk/items/3-nike?ref=1", now: NOW });
    expect(s?.searchQuery).toBe("nike pegasus 40");
    expect(s?.observedListings.map((c) => c.id)).toEqual(["2"]);
    expect(surveyForCase([older, newer], { platform: "depop", pageUrl: "https://www.depop.com/products/x", now: NOW })).toBeNull();
    expect(surveyForCase([{ ...newer, cards: [mk("2", iso(SURVEY_TTL_MS + 5))] }], { platform: "vinted", pageUrl: "https://www.vinted.co.uk/items/9-x", now: NOW })).toBeNull();
    // The search the listing came from wins over a more recent one.
    expect(surveyForCase([older, newer], { platform: "vinted", pageUrl: "https://www.vinted.co.uk/items/9-x", now: NOW, searchKey: "vinted:x" })?.searchQuery).toBe("x");
    expect(surveyForCase([older, newer], { platform: "vinted", pageUrl: "https://www.vinted.co.uk/items/9-x", now: NOW, searchKey: "vinted:gone" })?.searchQuery).toBe("nike pegasus 40");
  });
});

describe("survey summary", () => {
  it("counts listings in your size and those that can't be matched to a model yet", () => {
    const cards = [
      mk("1", iso(0), { title: "Nike Pegasus 40 UK 9" }),
      mk("2", iso(0), { title: "Nike Pegasus 41", sizeText: "44" }), // EU 44 = UK 9 on the Nike chart
      mk("3", iso(0), { title: "Nike Pegasus 40 UK 10" }),
      mk("4", iso(0), { title: "Nike trainers size 9" }), // names no model
      mk("5", iso(0), { title: "Saucony Endorphin Speed 4 UK 9" }), // no catalogue model, not the search
    ];
    const profile = { sizes: [{ brand: "Nike", size: 9, system: "UK" as const }], priorities: [], wearTolerance: "light" as const };
    const s = summariseSurvey({ cards, query: "nike pegasus 40" }, profile);
    expect(s).toEqual({ total: 5, inYourSize: 4, unmatched: 2 });
    expect(summaryLine(s)).toBe("Surveyed 5 listings · 4 in your size · 2 couldn't be matched to a model yet");
    expect(summaryLine(summariseSurvey({ cards, query: "" }, null))).toBe("Surveyed 5 listings · 2 couldn't be matched to a model yet");
    expect(queryModel("saucony endorphin speed 4")).toBeNull(); // no size chart or catalogue entry for the brand
    expect(queryModel("nike vomero 17")).toMatchObject({ brand: "nike", family: ["vomero"], version: "17" });
  });
});

describe("Price exhibit: your search", () => {
  it("explains the comparison and counts", () => {
    const v = observedView(OBSERVED)!;
    expect(v.lines[0]).toBe("6 similar listings seen, £28 to £55 (4 exact, 2 not stating the version) in your search for “nike pegasus 40” on 14 Nov. Too few exact matches to compare the price with.");
    expect(v.lines).toContain("Vinted prices without the buyer protection fee.");
    expect(v.counts).toBe("Surveyed 21 listings: 4 exact, 2 not stating the version, 6 other versions, 9 not this model.");
    expect(observedView({ ...OBSERVED, note: "Couldn't compare: model unknown.", context: null })!.lines[0]).toBe("Couldn't compare: model unknown.");
    expect(observedView({ ...OBSERVED, stats: { n: 8, excluded: 0, median: 40, p10: 30, p25: 35, p75: 45, p90: 50 }, source: "observed_listings" })!.lines[0]).toBe(
      "Compared with 8 listings from your search for “nike pegasus 40” on 14 Nov: median £40, middle half £35–£45.",
    );
    expect(observedView(null)).toBeNull();
  });
});
