import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import type { ListingColour, ListingFacts, NewOffers } from "@/schemas/domain";
import { colourFieldNames, colourWordsIn, hasStyleCode } from "@/lib/colourWords";
import { createNewPriceClient, shoppingQueries, summariseOffers, toNewOffers, type RawShoppingResult, type ShoppingOffer } from "@/lib/newPrices";
import { determineListingColour } from "@/pipeline/listingColour";
import { colourBasis, COLOURS_VARY, matchOfferColours, titleColourMatch } from "@/pipeline/offerColour";
import { checkPrice } from "@/pipeline/checks/price";
import { buyNewMove } from "@/pipeline/nextMoves";
import { check } from "./helpers";

const colourFixture = (f: string) => new Uint8Array(fs.readFileSync(path.join(__dirname, "fixtures", "colour", f)));
const facts = (over: Partial<ListingFacts> = {}): ListingFacts => ({ platform: "ebay", photoCount: 1, conditionClaims: [], evidence: [], ...over });
const listing = (names: ListingColour["names"], over: Partial<ListingColour> = {}): ListingColour => ({ names, source: "title", confidence: 0.75, evidence: [], conflicts: [], ...over });
const offer = (retailer: string, priceGBP: number, title: string, thumbnailUrl?: string): ShoppingOffer => ({ retailer, priceGBP, title, url: `https://shop.test/${retailer}`, ...(thumbnailUrl ? { thumbnailUrl } : {}) });

describe("colour words", () => {
  it("reads broad colours from titles in order", () => {
    expect(colourWordsIn("Nike Mens Running Trainers revolution 6 next na Lace Up black white UK Size")).toEqual(["black", "white"]);
    expect(colourWordsIn("Nike P-6000 Wolf Grey/Metallic Silver")).toEqual(["grey"]);
    expect(colourWordsIn("adidas Samba OG Cloud White / Core Black")).toEqual(["white", "black"]);
    expect(colourWordsIn("Nike Revolution 6 Next Nature")).toEqual([]);
  });
  it("treats generic colour fields as no evidence", () => {
    expect(colourFieldNames("Multicoloured")).toBeNull();
    expect(colourFieldNames("Multi")).toBeNull();
    expect(colourFieldNames("Assorted")).toBeNull();
    expect(colourFieldNames("Grey, White")).toEqual(["grey", "white"]);
  });
  it("matches style codes ignoring spaces and dashes", () => {
    expect(hasStyleCode("Nike Revolution 6 DC3728 003 Black", "DC3728-003")).toBe(true);
    expect(hasStyleCode("Nike Revolution 6 DC3728-001", "DC3728-003")).toBe(false);
  });
});

describe("the listing's colour", () => {
  it("eBay: 'Multicoloured' is weak, so the colour comes from the title words", async () => {
    const c = await determineListingColour({ facts: facts({ colourText: "Multicoloured", title: "Nike Mens Running Trainers revolution 6 next na Lace Up black white UK Size" }) });
    expect(c).toMatchObject({ names: ["black", "white"], source: "title", confidence: 0.75, conflicts: [] });
    expect(c!.evidence.find((e) => e.source === "colour_field")?.note).toBe('Colour field says "Multicoloured": too generic to use');
  });

  it("a specific colour field beats the title and the photo, and disagreements are recorded", async () => {
    const c = await determineListingColour({
      facts: facts({ colourText: "Grey, White", title: "Black Nike P6000" }),
      mainPhoto: { bytes: colourFixture("vinted-p6000-main.jpg"), mimeType: "image/jpeg", index: 0 },
    });
    expect(c).toMatchObject({ names: ["grey", "white"], source: "colour_field" });
    expect(c!.conflicts).toEqual([{ source: "title", names: ["black"] }]);
    expect(c!.evidence.find((e) => e.source === "photo")?.names[0]).toBe("grey");
  });

  it("a style code is the strongest source; names still come from the next source", async () => {
    const c = await determineListingColour({ facts: facts({ styleCode: "DC3728-003", title: "Nike Revolution 6 black white" }) });
    expect(c).toMatchObject({ names: ["black", "white"], source: "style_code", confidence: 0.95, styleCode: "DC3728-003" });
  });

  it("photo analysis only when nothing else says, and Vinted's dominant colour is never used (it's the backdrop)", async () => {
    const c = await determineListingColour({
      facts: facts({ title: "Nike P6000", dominantColourHint: "#E0DDD9" }),
      mainPhoto: { bytes: colourFixture("vinted-p6000-main.jpg"), mimeType: "image/jpeg", index: 0 },
    });
    expect(c).toMatchObject({ names: ["grey"], source: "photo", confidence: 0.45 });
    expect(c!.evidence.find((e) => e.source === "photo_hint")?.note).toMatch(/mostly the backdrop, so it isn't used/);
  });
});

describe("offer colour matching", () => {
  const bw = listing(["black", "white"], { styleCode: "DC3728-003" });

  it("1. a style code in the offer title is the same colourway", () => {
    expect(titleColourMatch("Nike Revolution 6 Next Nature DC3728-003", bw)).toEqual({ match: "same", evidence: "Style code DC3728-003 in the title" });
  });

  it("2. colour words in the offer title", () => {
    expect(titleColourMatch("Nike Revolution 6 Next Nature Black/White", bw)).toEqual({ match: "same", evidence: "Title says Black/White" });
    expect(titleColourMatch("Nike Revolution 6 Next Nature White/Black", bw).match).toBe("same"); // same pair of colours
    expect(titleColourMatch("Nike Revolution 6 Next Nature Grey", bw)).toEqual({ match: "different", evidence: "Title says Grey" });
    expect(titleColourMatch("Nike Revolution 6 Next Nature Black", bw).match).toBe("same"); // a subset of the listing's colours
    // Any colour the listing doesn't have is a different colourway (seen on live P-6000 offers).
    const gw = listing(["grey", "white"]);
    expect(titleColourMatch("Nike P-6000 Silver Burgundy Plum Chalk (Women's)", gw)).toEqual({ match: "different", evidence: "Title says Grey/Red/Purple" });
    expect(titleColourMatch("Nike P-6000 'White Metallic Silver Black'", gw).match).toBe("different");
    expect(titleColourMatch("Mens Nike P-6000 Trainers Metallic Silver", gw).match).toBe("same");
    expect(titleColourMatch("Nike Revolution 6 Next Nature", bw)).toEqual({ match: "unknown" });
  });

  it("3. the thumbnail's colours when the title doesn't say (background removed)", async () => {
    const black = new Uint8Array(await sharp({ create: { width: 120, height: 80, channels: 3, background: "#ffffff" } }).composite([{ input: await sharp({ create: { width: 70, height: 40, channels: 3, background: "#151515" } }).png().toBuffer(), left: 25, top: 20 }]).png().toBuffer());
    const red = new Uint8Array(await sharp({ create: { width: 120, height: 80, channels: 3, background: "#ffffff" } }).composite([{ input: await sharp({ create: { width: 70, height: 40, channels: 3, background: "#c81e1e" } }).png().toBuffer(), left: 25, top: 20 }]).png().toBuffer());
    const thumbs: Record<string, Uint8Array> = { "https://t/black": black, "https://t/red": red };
    const fetched: string[] = [];
    const out = await matchOfferColours(
      [offer("A", 50, "Nike Revolution 6 Next Nature Black/White", "https://t/none"), offer("B", 52, "Nike Revolution 6 Next Nature", "https://t/black"), offer("C", 55, "Nike Revolution 6 Next Nature", "https://t/red"), offer("D", 60, "Nike Revolution 6 Next Nature")],
      bw,
      { fetchThumbnail: async (u) => (fetched.push(u), thumbs[u] ?? null) },
    );
    expect(out.map((o) => o.colourMatch)).toEqual(["same", "same", "different", "unknown"]);
    expect(out[1].colourEvidence).toMatch(/^Thumbnail looks black/);
    expect(out[2].colourEvidence).toMatch(/^Thumbnail looks red/);
    expect(fetched).toEqual(["https://t/black", "https://t/red"]); // only when the title doesn't settle it
  });

  it("without a listing colour, every offer is unknown and no thumbnail is read", async () => {
    let fetched = 0;
    const out = await matchOfferColours([offer("A", 50, "Nike Revolution 6 Black", "https://t/x")], undefined, { fetchThumbnail: async () => (fetched++, null) });
    expect(out[0].colourMatch).toBe("unknown");
    expect(fetched).toBe(0);
  });
});

describe("new-price figure and offer cards by colour", () => {
  const same = (r: string, p: number) => ({ ...offer(r, p, `Nike Revolution 6 Black/White (${r})`), colourMatch: "same" as const, colourEvidence: "Title says Black/White" });
  const diff = (r: string, p: number) => ({ ...offer(r, p, `Nike Revolution 6 Grey (${r})`), colourMatch: "different" as const, colourEvidence: "Title says Grey" });

  it("uses same-colour offers when there are at least 3", () => {
    expect(colourBasis([same("A", 50), same("B", 60), same("C", 70), diff("D", 30)])).toMatchObject({ basis: "same_colour", note: null, offers: [{ retailer: "A" }, { retailer: "B" }, { retailer: "C" }] });
  });

  it("otherwise uses every matching-model offer and says colours vary", () => {
    expect(colourBasis([same("A", 50), same("B", 60), diff("D", 30)])).toMatchObject({ basis: "all_colours", note: COLOURS_VARY });
  });

  it("price check: the new price is the median of the same-colour offers, and the cards put them first", async () => {
    const all = [diff("Cheap", 30), same("A", 50), same("B", 60), same("C", 70), diff("D", 40)];
    const r = await checkPrice({
      facts: facts({ priceGBP: 65 }),
      needs: { sizes: [], priorities: [], wearTolerance: "light", extraPriorities: [], assumptions: [] },
      model: { id: null, brand: "Nike", name: "Revolution 6" },
      samples: [],
      lookupNewPrices: async () => summariseOffers(all.map(({ colourMatch, colourEvidence, ...o }) => o), { checkedOn: "2026-11-14", query: "Nike Revolution 6 black", rawResults: 5 }),
      assessOfferColours: async (offers) => offers.map((o) => all.find((a) => a.retailer === o.retailer)!),
    });
    expect(r.details).toMatchObject({ newPrice: { gbp: 60, sources: 3, colourBasis: "same_colour" }, position: "at_or_above_new" });
    const cards = (r.details as { newOffers: NewOffers }).newOffers;
    expect(cards.offers.map((o) => [o.retailer, o.colourMatch])).toEqual([["A", "same"], ["B", "same"], ["C", "same"], ["Cheap", "different"], ["D", "different"]]);
    expect(cards.offers.find((o) => o.isLowest)?.retailer).toBe("Cheap");
    expect(cards.colourNote).toBeUndefined();
    expect(r.evidence.find((e) => e.label.startsWith("New price"))?.label).toBe("New price £60, median of 3 UK retailers in the same colour, checked 14 Nov");
  });

  it("buy-new suggests only same-colour offers, else says the colour is different", () => {
    const price = (offers: ShoppingOffer[]) => check({ check: "price", status: "fail", details: { position: "at_or_above_new", newOffers: toNewOffers({ offers, checkedOn: "2026-11-14" }, 80) } });
    expect(buyNewMove([price([diff("Cheap", 30), same("A", 50), same("B", 60)])])?.text).toBe("Consider buying new: 2 UK retailers sell this model new in the same colour, from £50.");
    expect(buyNewMove([price([diff("Cheap", 30), diff("D", 40)])])?.text).toBe("Available new in a different colour from £30.");
  });
});

describe("Shopping query by colour", () => {
  const raw = (source: string, price: number, title: string): RawShoppingResult => ({ source, title, price: `£${price}`, extracted_price: price, link: `https://${source}.test/p` });

  it("style code first, else model plus the main colour; the plain query only when too few offers were kept", async () => {
    expect(shoppingQueries("Nike", "Revolution 6", { styleCode: "DC3728-003", colour: "black" })).toEqual(["Nike DC3728-003", "Nike Revolution 6"]);
    expect(shoppingQueries("Nike", "Revolution 6", { colour: "black" })).toEqual(["Nike Revolution 6 black", "Nike Revolution 6"]);
    expect(shoppingQueries("Nike", "Revolution 6")).toEqual(["Nike Revolution 6"]);

    const requests: string[] = [];
    const byQuery: Record<string, RawShoppingResult[]> = {
      "Nike DC3728-003": [raw("Schuh", 50, "Nike DC3728-003 trainers"), raw("JD", 55, "Nike Revolution 6 DC3728-003")],
      "Nike Revolution 6": [raw("Office", 52, "Nike Revolution 6 Black"), raw("Next", 58, "Nike Revolution 6 Grey")],
    };
    const client = createNewPriceClient({
      apiKey: "k",
      mode: "off",
      store: null,
      logger: () => undefined,
      now: () => new Date("2026-11-14T12:00:00Z"),
      fetch: async (url) => {
        const q = new URL(url).searchParams.get("q") ?? "";
        requests.push(q);
        return { ok: true, status: 200, json: async () => ({ shopping_results: byQuery[q] ?? [] }) };
      },
    });
    const r = await client.getNewPrices("Revolution 6", "Nike", { styleCode: "DC3728-003", colour: "black" });
    expect(requests).toEqual(["Nike DC3728-003", "Nike Revolution 6"]); // 2 kept from the style code: fall back
    expect(r.queries).toEqual(requests);
    expect(r.offers.map((o) => o.retailer).sort()).toEqual(["JD", "Next", "Office", "Schuh"]); // style-code titles kept even without the model name

    requests.length = 0;
    byQuery["Nike DC3728-003"].push(raw("Office", 51, "Nike DC3728-003"));
    await client.getNewPrices("Revolution 6", "Nike", { styleCode: "DC3728-003" });
    expect(requests).toEqual(["Nike DC3728-003"]); // 3 kept: no fallback
  });
});
