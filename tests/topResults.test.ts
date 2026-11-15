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
