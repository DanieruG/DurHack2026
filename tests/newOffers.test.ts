import { describe, expect, it } from "vitest";
import { createCase } from "@/pipeline";
import { caseDetail } from "@/pipeline/views";
import { checkPrice } from "@/pipeline/checks/price";
import { BUY_NEW_MOVE_ID, buyNewMove, generateNextMoves } from "@/pipeline/nextMoves";
import {
  createNewPriceClient,
  filterOffers,
  offerThumbnail,
  offerUrl,
  shoppingCacheKey,
  shoppingQuery,
  shoppingQueries,
  summariseOffers,
  toNewOffers,
  type RawShoppingResult,
  type ShoppingOffer,
} from "@/lib/newPrices";
import { SseEventSchemas } from "@/schemas/api";
import type { CheckResult, ListingFacts, NewOffers } from "@/schemas/domain";
import { check, fixtureReference, json, makeDeps, PAGE_TEXT, PROFILE } from "./helpers";

const THUMB = "https://encrypted-tbn1.gstatic.com/shopping?q=tbn:ANd9GcTest";
const offer = (retailer: string, priceGBP: number, over: Partial<ShoppingOffer> = {}): ShoppingOffer => ({
  retailer,
  priceGBP,
  title: `Nike Pegasus 40 at ${retailer}`,
  url: `https://www.${retailer.toLowerCase().replace(/\W+/g, "")}.co.uk/p/1`,
  ...over,
});

describe("new offers: card data", () => {
  it("sorts offers lowest first and marks exactly one isLowest (also on a tie)", () => {
    const r = toNewOffers({ offers: [offer("FARFETCH", 120), offer("Decathlon UK", 79.99), offer("JD Sports", 79.99), offer("Schuh", 95)], checkedOn: "2026-11-14" }, 85);
    expect(r.offers.map((o) => o.priceGBP)).toEqual([79.99, 79.99, 95, 120]);
    expect(r.offers.filter((o) => o.isLowest)).toHaveLength(1);
    expect(r.offers[0]).toMatchObject({ retailer: "Decathlon UK", isLowest: true }); // tie: Shopping's order decides
    expect(r).toMatchObject({ checkedOn: "2026-11-14", enoughForComparison: true });
  });

  it("differenceGBP is offer minus listing: positive when dearer, negative when cheaper", () => {
    const r = toNewOffers({ offers: [offer("Schuh", 48.5), offer("Decathlon UK", 41.01)], checkedOn: "2026-11-14" }, 45);
    expect(r.offers.map((o) => [o.retailer, o.differenceGBP])).toEqual([
      ["Decathlon UK", -3.99],
      ["Schuh", 3.5],
    ]);
  });

  it("fewer than 3 offers: still returned, flagged enoughForComparison: false", () => {
    expect(toNewOffers({ offers: [offer("Schuh", 90), offer("Decathlon UK", 80)], checkedOn: "2026-11-14" }, 40)).toMatchObject({
      enoughForComparison: false,
      offers: [{ retailer: "Decathlon UK" }, { retailer: "Schuh" }],
    });
    expect(toNewOffers({ offers: [], checkedOn: "2026-11-14" }, 40)).toEqual({ offers: [], checkedOn: "2026-11-14", enoughForComparison: false });
  });

  it("carries only allowed thumbnails, leaves out offers with nothing to open, and holds retailer data only", () => {
    const r = toNewOffers(
      { offers: [offer("Schuh", 90, { thumbnailUrl: THUMB }), offer("Odd", 95, { thumbnailUrl: "https://evil.example/x.png" }), offer("NoLink", 70, { url: "" })], checkedOn: "2026-11-14" },
      40,
    );
    expect(r.offers.map((o) => o.retailer)).toEqual(["Schuh", "Odd"]);
    expect(r.offers[0].thumbnailUrl).toBe(THUMB);
    expect(r.offers[1]).not.toHaveProperty("thumbnailUrl");
    for (const o of r.offers) expect(Object.keys(o).sort()).toEqual(["colourMatch", "differenceGBP", "isLowest", "priceGBP", "retailer", "title", "url", ...(o.thumbnailUrl ? ["thumbnailUrl"] : [])].sort());
  });
});

describe("new offers: links and thumbnails", () => {
  const google = "https://www.google.co.uk/search?ibp=oshop&q=Nike+Pegasus+40&prds=catalogid:1";

  it("prefers the retailer's direct link, then an unwrapped Google redirect, then the Google page", () => {
    expect(offerUrl({ link: "https://www.decathlon.co.uk/p/pegasus-40", product_link: google })).toBe("https://www.decathlon.co.uk/p/pegasus-40");
    expect(offerUrl({ link: "https://www.google.com/url?url=https%3A%2F%2Fwww.schuh.co.uk%2Fp%2F1&sa=U", product_link: google })).toBe("https://www.schuh.co.uk/p/1");
    expect(offerUrl({ product_link: google })).toBe(new URL(google).toString());
  });

  it("never returns a non-http(s) link", () => {
    expect(offerUrl({ link: "javascript:alert(1)" })).toBe("");
    expect(offerUrl({ link: "javascript:alert(1)", product_link: google })).toBe(new URL(google).toString());
  });

  it("accepts thumbnails only over https from encrypted-tbn*.gstatic.com", () => {
    expect(offerThumbnail(THUMB)).toBe(THUMB);
    expect(offerThumbnail("http://encrypted-tbn1.gstatic.com/shopping?q=x")).toBeUndefined();
    expect(offerThumbnail("https://serpapi.com/images/url/abc")).toBeUndefined();
    expect(offerThumbnail("https://encrypted-tbn1.gstatic.com.evil.example/x")).toBeUndefined();
    expect(offerThumbnail(undefined)).toBeUndefined();
  });

  it("keeps the thumbnail through filtering and the 24-hour cache", async () => {
    const raw: RawShoppingResult[] = [{ title: "Nike Pegasus 40 Men's", source: "Schuh", price: "£90.00", extracted_price: 90, product_link: google, thumbnail: THUMB }];
    expect(filterOffers(raw, { brand: "Nike", modelName: "Pegasus 40" })[0].thumbnailUrl).toBe(THUMB);
    const store = new (await import("@/lib/store")).MemoryStore(fixtureReference());
    const client = createNewPriceClient({
      apiKey: "k",
      mode: "off",
      store,
      logger: () => undefined,
      fetch: async () => ({ ok: true, status: 200, json: async () => ({ shopping_results: raw.map((r) => ({ ...r, position: 1, rating: 4.5 })) }) }),
    });
    await client.getNewPrices("Pegasus 40", "Nike");
    expect(await store.cacheGet(shoppingCacheKey(shoppingQuery("Nike", "Pegasus 40")))).toMatchObject({ results: [{ thumbnail: THUMB }] });
  });
});

describe("new offers: price check", () => {
  const needs = { sizes: [], priorities: [], wearTolerance: "light" as const, extraPriorities: [], assumptions: [] };
  const facts = { platform: "ebay", photoCount: 1, conditionClaims: [], priceGBP: 45, evidence: [] } as ListingFacts;

  it("reports the offers as soon as the lookup returns, and keeps them in details.newOffers", async () => {
    const order: string[] = [];
    let sent: NewOffers | undefined;
    const r = await checkPrice({
      facts,
      needs,
      model: { id: null, brand: "Nike", name: "Pegasus 40" },
      samples: [],
      lookupNewPrices: async () => {
        order.push("lookup");
        return summariseOffers([offer("Schuh", 48), offer("Decathlon UK", 41)], { checkedOn: "2026-11-14", query: "Nike Pegasus 40", rawResults: 2 });
      },
      onNewOffers: (o) => {
        order.push("new_offers");
        sent = o;
      },
    });
    expect(order).toEqual(["lookup", "new_offers"]);
    expect(sent).toEqual({
      checkedOn: "2026-11-14",
      enoughForComparison: false,
      offers: [
        expect.objectContaining({ retailer: "Decathlon UK", priceGBP: 41, differenceGBP: -4, isLowest: true }),
        expect.objectContaining({ retailer: "Schuh", priceGBP: 48, differenceGBP: 3, isLowest: false }),
      ],
    });
    expect(r.details?.newOffers).toEqual(sent);
    // The price rules are unchanged: two retailers are not enough for a new price.
    expect(r).toMatchObject({ status: "unknown", details: { searchFailed: true, retailerOffers: 2 } });
    expect(r.details).not.toHaveProperty("newPrice");
  });

  it("sends nothing when the lookup fails", async () => {
    let calls = 0;
    const r = await checkPrice({
      facts,
      needs,
      model: { id: null, brand: "Nike", name: "Pegasus 40" },
      samples: [],
      lookupNewPrices: async () => Promise.reject(new Error("HTTP 500")),
      onNewOffers: () => calls++,
    });
    expect(calls).toBe(0);
    expect(r.details).not.toHaveProperty("newOffers");
  });
});

describe("new offers: stream and case detail", () => {
  const pegasus39: RawShoppingResult[] = [
    { title: "Nike Air Zoom Pegasus 39 Men's", source: "Nike", price: "£100.00", extracted_price: 100, product_link: "https://www.google.co.uk/search?q=1", link: "https://www.nike.com/gb/t/pegasus-39", thumbnail: THUMB },
    { title: "Nike Pegasus 39 Running Shoes", source: "JD Sports", price: "£105.00", extracted_price: 105, product_link: "https://www.google.co.uk/search?q=2" },
    { title: "Nike Pegasus 39 Men's Road Running", source: "SportsShoes.com", price: "£95.00", extracted_price: 95, product_link: "https://www.google.co.uk/search?q=3" },
  ];
  const handlers = {
    identify: () => json({ brand: "Nike", brandConfidence: 0.95, modelName: "Nike Pegasus 39", catalogueModelId: null, confidence: 0.9, reasons: "Tongue label reads Pegasus 39", evidence: [] }),
  };
  const capture = { pageUrl: "https://www.vinted.co.uk/items/1", pageText: PAGE_TEXT, imageUrls: ["https://img.example.com/1.jpg"] };

  async function run(deps: ReturnType<typeof makeDeps>) {
    const { caseId, done } = await createCase(deps, { capture, profile: PROFILE, screenshots: [] });
    await done;
    return { caseId, events: deps.hub.events(caseId) };
  }

  it("sends new_offers before the price check finishes when the Shopping result comes from the cache", async () => {
    const deps = makeDeps({ handlers });
    // Seed the 24-hour cache, then make any network call fail.
    // The test photos read as red, so the colour query runs first; both are cached.
    for (const q of shoppingQueries("Nike", "Pegasus 39", { colour: "red" })) {
      await deps.store.cacheSet(shoppingCacheKey(q), { fetchedAt: "2026-11-14T08:00:00.000Z", results: pegasus39 });
    }
    let network = 0;
    deps.newPrices = createNewPriceClient({
      apiKey: "k",
      mode: "off",
      store: deps.store,
      now: deps.now,
      logger: () => undefined,
      fetch: async () => {
        network++;
        throw new Error("must be served from the cache");
      },
    });
    const { caseId, events } = await run(deps);
    expect(network).toBe(0);
    const i = events.findIndex((e) => e.event === "new_offers");
    const priceDone = events.findIndex((e) => e.event === "check_done" && (e.data as CheckResult).check === "price");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(priceDone);
    const data = events[i].data as NewOffers;
    expect(SseEventSchemas.new_offers.safeParse(data).success).toBe(true);
    const price = events[priceDone].data as CheckResult;
    expect(price.usage?.search).toEqual({ kind: "shopping", live: false });
    const listing = (price.details as { listingPriceGBP: number }).listingPriceGBP;
    expect(data).toMatchObject({ checkedOn: "2026-11-14", enoughForComparison: true });
    expect(data.offers.map((o) => [o.retailer, o.priceGBP, o.differenceGBP, o.isLowest])).toEqual([
      ["SportsShoes.com", 95, 95 - listing, true],
      ["Nike", 100, 100 - listing, false],
      ["JD Sports", 105, 105 - listing, false],
    ]);
    expect(data.offers[1]).toMatchObject({ url: "https://www.nike.com/gb/t/pegasus-39", thumbnailUrl: THUMB }); // direct link preferred
    expect(data.offers[0].url).toBe("https://www.google.co.uk/search?q=3"); // no direct link: Google page

    const detail = await caseDetail(deps, (await deps.store.getCase(caseId))!, "http://x.test");
    expect(detail.newOffers).toEqual(data);
    expect((detail.checks.find((c) => c.check === "price")!.details as { newOffers: unknown }).newOffers).toEqual(data);
  });

  it("with fewer than 3 offers, still sends them (enoughForComparison: false) and the price check stays unknown", async () => {
    const deps = makeDeps({ handlers, shopping: { "Nike Pegasus 39": pegasus39.slice(0, 2) } });
    const { caseId, events } = await run(deps);
    const data = events.find((e) => e.event === "new_offers")!.data as NewOffers;
    expect(data.enoughForComparison).toBe(false);
    expect(data.offers.map((o) => o.retailer)).toEqual(["Nike", "JD Sports"]);
    const price = events.filter((e) => e.event === "check_done" && (e.data as CheckResult).check === "price").at(-1)!.data as CheckResult;
    expect(price.status).toBe("unknown");
    expect((await caseDetail(deps, (await deps.store.getCase(caseId))!, "http://x.test")).newOffers).toMatchObject({ enoughForComparison: false });
  });
});

describe("new offers: Consider buying new", () => {
  const offers = toNewOffers({ offers: [offer("Schuh", 90), offer("Decathlon UK", 79.99), offer("JD Sports", 95)], checkedOn: "2026-11-14" }, 95);
  const price = (position: string, newOffers?: NewOffers) => check({ check: "price", status: "fail", details: { position, ...(newOffers ? { newOffers } : {}) } });

  it("is added only when the listing costs as much as new and offers were found", async () => {
    expect(buyNewMove([price("at_or_above_new", offers)])).toEqual({
      id: BUY_NEW_MOVE_ID,
      kind: "before_you_pay",
      text: "Consider buying new: 3 UK retailers sell this model new, from £79.99. The offers don't show their colour, so check it matches.",
      relatesTo: ["price"],
    });
    expect(buyNewMove([price("typical", offers)])).toBeNull();
    expect(buyNewMove([price("at_or_above_new")])).toBeNull();
    const moves = await generateNextMoves(null, { checks: [check({ check: "fit", status: "pass" }), price("at_or_above_new", offers)], leads: [], label: "overpriced" });
    expect(moves.map((m) => m.id)).toEqual([BUY_NEW_MOVE_ID]);
  });
});
