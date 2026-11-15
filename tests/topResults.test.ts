import { describe, expect, it } from "vitest";
import { topResults, wishColours, TOP_RESULTS } from "@/extension/src/lib/topResults";
import type { SurveyCard } from "@/extension/src/lib/survey";
import { ProfileSchema } from "@/schemas/domain";

const profile = ProfileSchema.parse({ defaultSize: { size: 9, system: "UK" }, priorities: [], wearTolerance: "light" });
let n = 0;
const card = (over: Partial<SurveyCard> = {}): SurveyCard => {
  n++;
  return {
    id: String(5000 + n),
    title: "Nike Pegasus 40 trainers",
    price: 40,
    currency: "GBP",
    url: `https://www.vinted.co.uk/items/${5000 + n}-x`,
    thumbnailUrl: `https://images1.vinted.net/t/${5000 + n}/a.webp`,
    sizeText: "UK 9",
    sponsored: false,
    priceBasis: "excl_buyer_protection",
    seenAt: "2026-11-14T10:00:00.000Z",
    ...over,
  };
};
const ids = (r: { card: SurveyCard }[]) => r.map((x) => x.card.id);

describe("topResults: which cards are eligible", () => {
  const base = [card({ id: "a", price: 30 }), card({ id: "b", price: 40 }), card({ id: "c", price: 50 }), card({ id: "d", price: 60 }), card({ id: "e", price: 70 })];
  it("drops sponsored, auctions, unpriced, non-GBP, non-https, the listing itself", () => {
    const noise = [
      card({ id: "s", sponsored: true, price: 5 }),
      card({ id: "au", buyingFormat: "auction", price: 5 }),
      card({ id: "np", price: null }),
      card({ id: "us", currency: "USD", price: 5 }),
      card({ id: "me", price: 5 }),
    ];
    const r = topResults([...base, ...noise], { profile, excludeId: "me" });
    expect(ids(r)).not.toEqual(expect.arrayContaining(["s"]));
    for (const bad of ["s", "au", "np", "us", "me"]) expect(ids(r)).not.toContain(bad);
  });
  it("only at or under the page's typical price once there are enough cards to compare", () => {
    const r = topResults(base, { profile });
    expect(ids(r)).toEqual(["a", "b", "c"]); // median is 50: the dearer ones are not "high potential"
  });
  it("a size we can read that isn't the buyer's is dropped; an unstated size stays (ranked lower)", () => {
    const cards = [card({ id: "ten", price: 20, sizeText: "UK 10" }), card({ id: "nine", price: 22 }), card({ id: "none", price: 20, sizeText: undefined, title: "Nike Pegasus 40" }), ...base];
    const r = topResults(cards, { profile });
    expect(ids(r)).not.toContain("ten");
    expect(ids(r)).toContain("none");
    expect(ids(r).indexOf("nine")).toBeLessThan(ids(r).indexOf("none"));
  });
  it("without any saved size nothing is filtered by size", () => {
    const r = topResults([card({ id: "ten", price: 20, sizeText: "UK 10" }), ...base], { profile: null });
    expect(ids(r)).toContain("ten");
  });
});

describe("topResults: ranking", () => {
  it("cheaper than typical ranks higher, with the reason said plainly", () => {
    const cards = [card({ id: "cheap", price: 20 }), card({ id: "mid", price: 38 }), card({ id: "x", price: 45 }), card({ id: "y", price: 50 }), card({ id: "z", price: 60 })];
    const r = topResults(cards, { profile });
    expect(r[0].card.id).toBe("cheap");
    expect(r[0].reason).toBe("£25 under typical · UK 9");
    expect(r[0].sizeLabel).toBe("UK 9");
    expect(r[0].typicalGBP).toBe(45);
  });
  it("title words matching the search lift a card", () => {
    const cards = [card({ id: "off", price: 30, title: "Nike running trainers" }), card({ id: "on", price: 31, title: "Nike Pegasus 40" }), card({ id: "p", price: 50 }), card({ id: "q", price: 55 }), card({ id: "r", price: 60 })];
    expect(topResults(cards, { profile, query: "nike pegasus 40" })[0].card.id).toBe("on");
  });
  it("the buyer's colour: a wanted colour in the title helps, an avoided one hurts", () => {
    const cards = [card({ id: "black", price: 30, title: "Nike Pegasus 40 black" }), card({ id: "white", price: 32, title: "Nike Pegasus 40 white" }), card({ id: "p", price: 50 }), card({ id: "q", price: 55 }), card({ id: "r", price: 60 })];
    const r = topResults(cards, { profile, colourWish: "all white, no black" });
    expect(r[0].card.id).toBe("white");
    expect(r[0].reason).toContain("white in the title");
    expect(ids(r).indexOf("black")).toBeGreaterThan(0);
  });
  it("is capped at 8, stable on ties, and empty for nothing eligible", () => {
    const many = Array.from({ length: 30 }, (_, i) => card({ id: `m${String(i).padStart(2, "0")}`, price: 20 + (i % 3) }));
    const r = topResults([...many, card({ id: "hi", price: 100 })], { profile });
    expect(r).toHaveLength(TOP_RESULTS);
    expect(topResults([...many, card({ id: "hi", price: 100 })], { profile })).toEqual(r);
    expect(topResults([], { profile })).toEqual([]);
    expect(topResults([card({ sponsored: true })], { profile })).toEqual([]);
  });
  it("with only a few cards there's no typical price to beat: they are all offered", () => {
    expect(topResults([card({ id: "a", price: 20 }), card({ id: "b", price: 90 })], { profile })).toHaveLength(2);
  });
});

describe("wishColours", () => {
  it("splits wanted and avoided colours", () => {
    expect(wishColours("all white, nothing neon; no black")).toEqual({ wanted: ["white"], avoided: ["black"] });
    expect(wishColours(undefined)).toEqual({ wanted: [], avoided: [] });
  });
});

import { analyseResults, explainResults, RANKED_MAX } from "@/extension/src/lib/topResults";

describe("analyseResults: what was left out, and why", () => {
  const cards = [
    card({ id: "a", price: 20 }),
    card({ id: "b", price: 25 }),
    card({ id: "c", price: 60 }),
    card({ id: "d", price: 70 }),
    card({ id: "ten", price: 22, sizeText: "UK 10" }),
    card({ id: "sp", sponsored: true }),
    card({ id: "au", buyingFormat: "auction" }),
    card({ id: "range", price: null }),
    card({ id: "usd", currency: "USD", price: 30 }),
    card({ id: "me", price: 15 }),
  ];
  it("counts every reason a card was not ranked", () => {
    const { ranked, counts } = analyseResults(cards, { profile, excludeId: "me" });
    expect(counts).toMatchObject({ read: 10, sponsored: 1, auctions: 1, unpriced: 1, otherCurrency: 1, self: 1, otherSize: 1, aboveTypical: 2 });
    expect(counts.ranked).toBe(ranked.length);
    expect(ranked.map((r) => r.card.id)).toEqual(["a", "b"]);
    // Every card is somewhere: ranked, or in exactly one reason.
    const c = counts;
    expect(c.ranked + c.sponsored + c.auctions + c.unpriced + c.otherCurrency + c.self + c.otherSize + c.aboveTypical).toBe(c.read);
  });
  it("explains in plain words, and never says nothing", () => {
    const { counts } = analyseResults(cards, { profile, excludeId: "me" });
    expect(explainResults(counts)).toBe("Read 10 listings. 2 look like good value; left out: 1 not in your size, 2 above the typical £25, 2 auctions or sponsored, 1 with no single price, 1 not priced in £.");
    expect(explainResults({ ...counts, ranked: 0, otherSize: 0, aboveTypical: 0, auctions: 0, sponsored: 0, unpriced: 0, otherCurrency: 0 })).toBe("Read 10 listings. None stood out as good value.");
    expect(explainResults(analyseResults([], { profile }).counts)).toBe("No listings read from this page yet.");
    expect(explainResults(analyseResults([card({ id: "x", sizeText: "UK 10" })], { profile }).counts)).toMatch(/^Read 1 listing\. None stood out as good value; left out: 1 not in your size\.$/);
  });
  it("'typical' comes from listings about the search, not whatever else is on the page", () => {
    const mixed = [card({ id: "on1", price: 30 }), card({ id: "on2", price: 32 }), card({ id: "on3", price: 34 }), ...Array.from({ length: 6 }, (_, i) => card({ id: `off${i}`, price: 200, title: "Adidas Samba OG" }))];
    expect(analyseResults(mixed, { profile, query: "nike pegasus 40" }).counts.typicalGBP).toBe(32);
    expect(analyseResults(mixed, { profile }).counts.typicalGBP).toBe(200);
  });
  it("keeps the whole ranked list for paging, capped only by the caller", () => {
    const many = Array.from({ length: 30 }, (_, i) => card({ id: `p${String(i).padStart(2, "0")}`, price: 20 + (i % 3) }));
    expect(analyseResults(many, { profile }).ranked.length).toBeGreaterThan(TOP_RESULTS);
    expect(RANKED_MAX).toBe(40);
  });
});
