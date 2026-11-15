// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { alternativeCandidates, matchSurvey, MAX_ALTERNATIVES, noAlternatives, prepareSurvey, toAlternatives } from "@/lib/observed";
import { deriveTokens } from "@/lib/titleMatch";
import { findAlternatives } from "@/pipeline/checks/price";
import { matchOfferColours } from "@/pipeline/offerColour";
import { AlternativeCards } from "@/extension/src/panel/offers";
import { CaseFile } from "@/extension/src/panel/screens/CaseFile";
import { alternativeLabel, alternativesView, NO_SURVEY_LINE, NOTHING_CHEAPER_LINE } from "@/extension/src/lib/alternatives";
import { ALTERNATIVES, CASE_FILE } from "@/extension/src/preview/fixtures";
import type { ListingColour, ListingFacts, ObservedAlternatives, ObservedListing, Platform } from "@/schemas/domain";
import { fixtureReference } from "./helpers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ref = fixtureReference();
const nikeChart = ref.sizeCharts.find((c) => c.id === "nike-mens")!;
const peg40 = deriveTokens("Nike", "Pegasus 40");
const PAGE_URL = "https://www.vinted.co.uk/items/777-nike-pegasus-40";

let n = 0;
function card(over: Partial<ObservedListing> = {}): ObservedListing {
  n++;
  return {
    id: String(7000 + n),
    title: "Nike Pegasus 40 UK 9",
    price: 30,
    currency: "GBP",
    url: `https://www.vinted.co.uk/items/${7000 + n}-nike-pegasus-40`,
    sponsored: false,
    priceBasis: "excl_buyer_protection",
    seenAt: "2026-11-14T10:00:00.000Z",
    ...over,
  };
}

/** Survey the cards as the pipeline does (dedupe, platform, drop the current listing and auctions), then match. */
function matched(cards: ObservedListing[], opts: { platform?: Platform; pageUrl?: string } = {}) {
  const survey = prepareSurvey(cards, { platform: opts.platform ?? "vinted", pageUrl: opts.pageUrl ?? PAGE_URL })!;
  return { survey, matched: matchSurvey(survey, peg40, nikeChart) };
}

const listing = (priceGBP: number, over: Partial<ListingFacts> = {}) => ({ priceGBP, ...over });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const greyWhite: ListingColour = { names: ["grey", "white"], source: "title", confidence: 0.8, evidence: [], conflicts: [] };

function candidates(cards: ObservedListing[], price: number, userSizeUK: number | null = 9, over: Partial<ListingFacts> = {}) {
  return alternativeCandidates(matched(cards).matched, { listing: listing(price, over), userSizeUK, platform: "vinted" });
}

describe("which surveyed listings qualify", () => {
  it("match level: exact and version-not-stated qualify; another version and other models never do", () => {
    const exact = card({ title: "Nike Pegasus 40 UK 9" });
    const unknown = card({ title: "Nike Pegasus trainers UK 9" });
    const other = card({ title: "Nike Pegasus 39 UK 9" });
    const none = card({ title: "Adidas Samba OG UK 9" });
    const got = candidates([exact, unknown, other, none], 45);
    expect(ids(got)).toEqual([exact.id, unknown.id]);
    expect(got.map((c) => c.level)).toEqual(["exact", "version_unknown"]);
  });

  it("size: the user's size or no size stated; other sizes and sizes that can't be checked are left out", () => {
    const mine = card({ title: "Nike Pegasus 40", sizeText: "UK 9" });
    const unstated = card({ title: "Nike Pegasus 40 trainers" });
    const bigger = card({ title: "Nike Pegasus 40", sizeText: "UK 10" });
    const unconvertible = card({ title: "Nike Pegasus 40", sizeText: "US 30" }); // off the chart: "US 30", no UK size
    const got = candidates([mine, unstated, bigger, unconvertible], 45);
    expect(ids(got).sort()).toEqual([mine.id, unstated.id].sort());
    expect(got.find((c) => c.id === mine.id)!.sizeLabel).toBe("UK 9");
    expect(got.find((c) => c.id === unstated.id)!.sizeLabel).toBeNull();
  });

  it("without a known size for the user, any adult size qualifies (never a child's)", () => {
    const nine = card({ title: "Nike Pegasus 40", sizeText: "UK 9" });
    const ten = card({ title: "Nike Pegasus 40", sizeText: "UK 10" });
    const kids = card({ title: "Nike Pegasus 40", sizeText: "UK 1" });
    expect(ids(candidates([nine, ten, kids], 45, null)).sort()).toEqual([nine.id, ten.id].sort());
  });

  it("colour: same rules as the Shopping offers; a different colour is left out, an unclear one is kept and labelled", async () => {
    const same = card({ title: "Nike Pegasus 40 grey white UK 9", price: 20 });
    const unclear = card({ title: "Nike Pegasus 40 UK 9", price: 22 });
    const different = card({ title: "Nike Pegasus 40 red UK 9", price: 21 });
    const { survey, matched: m } = matched([same, unclear, different]);
    const out = await findAlternatives({
      facts: { priceGBP: 45, listingColour: greyWhite } as ListingFacts,
      observed: { survey, matched: m, userSizeUK: 9 },
      assessListingColours: (cs) => matchOfferColours(cs, greyWhite),
    });
    expect(out.alternatives.map((a) => [a.listingId, a.colourMatch])).toEqual([
      [same.id, "same"],
      [unclear.id, "unknown"],
    ]);
  });

  it("an unclear thumbnail stays unclear; a thumbnail clearly in another colour is left out", async () => {
    const redPhoto = card({ title: "Nike Pegasus 40 UK 9", price: 20, thumbnailUrl: "https://images1.vinted.net/t/red.webp" });
    const multiPhoto = card({ title: "Nike Pegasus 40 UK 9", price: 21, thumbnailUrl: "https://images1.vinted.net/t/multi.webp" });
    const { survey, matched: m } = matched([redPhoto, multiPhoto]);
    const analyse = vi.fn(async (b: Uint8Array) =>
      b[0] === 1
        ? { colours: [{ name: "red" as const, share: 0.8, hex: "#c00000" }], multi: false }
        : { colours: [{ name: "red" as const, share: 0.4, hex: "#c00000" }, { name: "blue" as const, share: 0.4, hex: "#0000c0" }], multi: true },
    );
    const out = await findAlternatives({
      facts: { priceGBP: 45 } as ListingFacts,
      observed: { survey, matched: m, userSizeUK: 9 },
      assessListingColours: (cs) =>
        matchOfferColours(cs, greyWhite, { fetchThumbnail: async (u) => new Uint8Array([u.includes("red") ? 1 : 2]), analyse: analyse as never }),
    });
    expect(out.alternatives.map((a) => [a.listingId, a.colourMatch])).toEqual([[multiPhoto.id, "unknown"]]);
  });

  it("eBay auctions never qualify (Buy It Now only)", () => {
    const ebay = (over: Partial<ObservedListing>) =>
      card({ url: `https://www.ebay.co.uk/itm/${8000 + n}`, priceBasis: "listed", ...over });
    const bin = ebay({ buyingFormat: "buy_it_now", price: 20 });
    const auction = ebay({ buyingFormat: "auction", price: 5 });
    const { survey, matched: m } = matched([bin, auction], { platform: "ebay", pageUrl: "https://www.ebay.co.uk/itm/111" });
    const got = alternativeCandidates(m, { listing: listing(45), userSizeUK: 9, platform: "ebay" });
    expect(ids(got)).toEqual([bin.id]);
    expect(survey.auctionsExcluded).toBe(1);
  });

  it("price: at least 10% or £5 cheaper, whichever is larger", () => {
    // £40 listing: 10% is £4, so £5 is needed. £35 qualifies; £35.01 doesn't.
    const five = card({ price: 35 });
    const short = card({ price: 35.01 });
    expect(ids(candidates([five, short], 40))).toEqual([five.id]);
    // £100 listing: 10% is £10. £90 qualifies; £91 (only £9 cheaper) doesn't.
    const ten = card({ price: 90 });
    const nine = card({ price: 91 });
    expect(ids(candidates([ten, nine], 100))).toEqual([ten.id]);
    // Dearer or the same price never qualifies.
    expect(candidates([card({ price: 40 }), card({ price: 60 })], 40)).toEqual([]);
  });

  it("price basis: listed prices only, never a total with postage", () => {
    // £40 listing, £46.20 with protection and postage. A £35 card is £5 cheaper on the listed price: it qualifies,
    // and the difference is against £40, not £46.20.
    const c = card({ price: 35 });
    const { survey, matched: m } = matched([c]);
    const facts = { priceGBP: 40, totalGBP: 46.2, totalIncludes: ["buyer_protection", "postage"] } as ListingFacts;
    const [a] = toAlternatives(alternativeCandidates(m, { listing: facts, userSizeUK: 9, platform: "vinted" }), survey).alternatives;
    expect(a).toMatchObject({ priceGBP: 35, priceBasis: "listed", differenceGBP: -5 });
    // £36 is only £4 cheaper on the listed price, though £10.20 under the total: not an alternative.
    expect(alternativeCandidates(matched([card({ price: 36 })]).matched, { listing: facts, userSizeUK: 9, platform: "vinted" })).toEqual([]);
  });

  it("sorts exact before version-not-stated, then cheapest first", () => {
    const vu15 = card({ title: "Nike Pegasus trainers UK 9", price: 15 });
    const ex30 = card({ title: "Nike Pegasus 40 UK 9", price: 30 });
    const ex25 = card({ title: "Nike Pegasus 40 UK 9", price: 25 });
    const vu20 = card({ title: "Nike Pegasus running shoes UK 9", price: 20 });
    expect(ids(candidates([vu15, ex30, ex25, vu20], 45))).toEqual([ex25.id, ex30.id, vu15.id, vu20.id]);
  });

  it("the listing being investigated never appears in its own alternatives", () => {
    const self = card({ id: "777", url: PAGE_URL, price: 1 });
    const sameUrl = card({ id: "777-dupe", url: `${PAGE_URL}/`, price: 2 }); // same page under another id
    const other = card({ price: 20 });
    const { survey, matched: m } = matched([self, sameUrl, other]);
    const out = toAlternatives(alternativeCandidates(m, { listing: listing(45), userSizeUK: 9, platform: "vinted" }), survey);
    expect(out.alternatives.map((a) => a.listingId)).toEqual([other.id]);
  });

  it("keeps only the card fields (no seller details) and caps how many are stored", () => {
    const many = Array.from({ length: MAX_ALTERNATIVES + 5 }, (_, i) => card({ price: 10 + i * 0.1, thumbnailUrl: "https://images1.vinted.net/t/x.webp" }));
    const { survey, matched: m } = matched(many);
    const out = toAlternatives(alternativeCandidates(m, { listing: listing(45), userSizeUK: 9, platform: "vinted" }), survey);
    expect(out.alternatives).toHaveLength(MAX_ALTERNATIVES);
    expect(Object.keys(out.alternatives[0]).sort()).toEqual(
      ["colourMatch", "differenceGBP", "listingId", "matchLevel", "observedOn", "platform", "priceBasis", "priceGBP", "size", "thumbnailUrl", "title", "url"].sort(),
    );
    expect(out).toMatchObject({ surveyUsed: true, platform: "vinted", surveyedOn: "2026-11-14" });
    expect(out.alternatives[0].observedOn).toBe("2026-11-14");
  });

  it("no survey: alternatives [] with surveyUsed false; a survey where nothing qualifies: surveyUsed true", async () => {
    expect(await findAlternatives({ facts: { priceGBP: 45 } as ListingFacts })).toEqual({ surveyUsed: false, platform: null, surveyedOn: null, alternatives: [] });
    const { survey, matched: m } = matched([card({ price: 44 })]);
    expect(await findAlternatives({ facts: { priceGBP: 45 } as ListingFacts, observed: { survey, matched: m, userSizeUK: 9 } })).toEqual(noAlternatives(survey));
    expect(noAlternatives(survey)).toEqual({ surveyUsed: true, platform: "vinted", surveyedOn: "2026-11-14", alternatives: [] });
  });
});

// ---------- the panel ----------

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(el: ReturnType<typeof h>): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(el));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const altCards = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>(".offer.alt")];

describe("Worth looking at (panel)", () => {
  it("shows 3 cards in the offer-card layout, then Show all {n}", () => {
    const el = render(h(AlternativeCards, { data: ALTERNATIVES }));
    expect(el.querySelector(".label")!.textContent).toBe("Worth looking at");
    expect(altCards(el)).toHaveLength(3);
    const first = altCards(el)[0];
    expect(first.querySelector(".offer-thumb")).not.toBeNull();
    expect(first.querySelector(".offer-title")!.textContent).toBe("Nike Air Zoom Pegasus 40 UK 9 grey and white, worn twice");
    expect(first.querySelector(".offer-retailer")!.textContent).toBe("Vinted · UK 9");
    expect(first.querySelector(".offer-price")!.textContent).toBe("£28");
    expect(first.querySelector(".offer-diff")!.textContent).toBe("£14 cheaper than this listing");
    const more = [...el.querySelectorAll("button")].find((b) => b.textContent === "Show all 4")!;
    act(() => more.click());
    expect(altCards(el)).toHaveLength(4);
  });

  it("labels size, version and colour where relevant, and every card says Not investigated yet", () => {
    const el = render(h(AlternativeCards, { data: ALTERNATIVES }));
    const [a, b, c] = altCards(el).map((x) => x.textContent!);
    expect(a).not.toContain("Version not stated");
    expect(b).toContain("Size not stated");
    expect(b).toContain("Colour unclear");
    expect(c).toContain("Version not stated");
    for (const t of [a, b, c]) {
      expect(t).toContain("Not investigated yet");
      expect(t).toContain("Postage not included");
    }
    expect(alternativeLabel(ALTERNATIVES.alternatives[1])).toBe(
      "Nike Pegasus 40 trainers on Vinted, £31, £11 cheaper than this listing, postage not included, Size not stated, colour unclear, not investigated yet, opens in a new tab",
    );
  });

  it("the card opens the listing in a new tab (one link, no control inside it); Investigate starts an investigation", () => {
    const onInvestigate = vi.fn();
    const el = render(h(AlternativeCards, { data: ALTERNATIVES, onInvestigate }));
    for (const c of altCards(el)) {
      const links = c.querySelectorAll("a");
      expect(links).toHaveLength(1);
      expect(links[0].getAttribute("target")).toBe("_blank");
      expect(links[0].getAttribute("rel")).toBe("noopener noreferrer");
      expect(links[0].querySelector("button")).toBeNull();
    }
    expect(altCards(el)[0].querySelector("a")!.getAttribute("href")).toBe("https://www.vinted.co.uk/items/4410001-nike-pegasus-40");
    const investigate = altCards(el)[1].querySelector<HTMLButtonElement>("button")!;
    expect(investigate.textContent).toBe("Investigate");
    expect(investigate.getAttribute("aria-label")).toBe("Investigate Nike Pegasus 40 trainers");
    act(() => investigate.click());
    expect(onInvestigate).toHaveBeenCalledWith("https://www.vinted.co.uk/items/4410003-nike-pegasus-40");
  });

  it("says where the cards came from", () => {
    const el = render(h(AlternativeCards, { data: ALTERNATIVES }));
    expect(el.textContent).toContain("From your Vinted search on 14 Nov. Only listings you surveyed.");
  });

  it("empty states: no survey, and a survey with nothing cheaper in the user's size", () => {
    const none: ObservedAlternatives = { surveyUsed: false, platform: null, surveyedOn: null, alternatives: [] };
    expect(alternativesView(none)).toEqual({ kind: "empty", line: NO_SURVEY_LINE });
    expect(alternativesView(null)).toEqual({ kind: "empty", line: NO_SURVEY_LINE });
    let el = render(h(AlternativeCards, { data: none }));
    expect(el.textContent).toBe(`Worth looking at${NO_SURVEY_LINE}`);
    act(() => root?.unmount());
    host?.remove();
    el = render(h(AlternativeCards, { data: { ...ALTERNATIVES, alternatives: [] } }));
    expect(el.textContent).toBe(`Worth looking at${NOTHING_CHEAPER_LINE}`);
    expect(NOTHING_CHEAPER_LINE).toBe("Nothing cheaper in your size from your search.");
    expect(altCards(el)).toHaveLength(0);
  });

  it("sits under the Price exhibit, after the new-price offers", () => {
    const el = render(
      h(CaseFile, {
        caseId: CASE_FILE.id,
        detail: CASE_FILE,
        listing: { title: "Nike Pegasus 40", priceGBP: 42 },
        initialOpen: ["price"],
        addEvidence: { busy: false, error: null, onCaptureTab: async () => null, onSubmit: () => undefined },
      }),
    );
    const body = [...el.querySelectorAll(".ev-body")].find((b) => b.querySelector(".alts"))!;
    const offers = body.querySelector("a.offer:not(.alt)")!;
    const alts = body.querySelector(".alts")!;
    expect(offers.compareDocumentPosition(alts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(body.textContent).not.toContain("Cheaper in your search");
  });
});
