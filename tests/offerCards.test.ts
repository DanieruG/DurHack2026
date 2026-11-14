// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { OfferCards, OffersSlot } from "@/extension/src/panel/offers";
import { CaseFile } from "@/extension/src/panel/screens/CaseFile";
import { differenceText, offerLabel, BUY_NEW_MOVE_ID as PANEL_BUY_NEW_ID } from "@/extension/src/lib/offers";
import { applyEvent, newInvestigation, offersSlot, type IncomingEvent } from "@/extension/src/lib/progress";
import { CASE_FILE, NEW_OFFERS } from "@/extension/src/preview/fixtures";
import { BUY_NEW_MOVE_ID } from "@/pipeline/nextMoves";
import type { CheckResult, NewOffers } from "@/schemas/domain";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

const THUMB = "https://encrypted-tbn1.gstatic.com/shopping?q=tbn:test";
const three: NewOffers = { ...NEW_OFFERS, offers: NEW_OFFERS.offers.slice(0, 3) };
const cards = (el: HTMLElement) => [...el.querySelectorAll<HTMLAnchorElement>("a.offer")];

describe("offer cards", () => {
  it("render from fixture data: title, retailer, price, difference, and Lowest on the cheapest only", () => {
    const el = render(h(OfferCards, { data: three }));
    const c = cards(el);
    expect(c).toHaveLength(3);
    expect(c[0].querySelector(".offer-title")!.textContent).toBe("Nike Air Zoom Pegasus 40 Men's Road Running Shoes");
    expect(c[0].querySelector(".offer-retailer")!.textContent).toBe("Decathlon UK");
    expect(c[0].querySelector(".offer-price")!.textContent).toBe("£75.23");
    expect(c[0].querySelector(".offer-diff")!.textContent).toBe("+£33.23 vs this listing");
    expect(c.map((a) => !!a.querySelector(".offer-lowest"))).toEqual([true, false, false]);
    expect(el.textContent).toContain("New prices checked 14 Nov. Check your size is in stock. Postage not included.");
  });

  it("each card is one link that opens the retailer page in a new tab, with an accessible label", () => {
    const el = render(h(OfferCards, { data: three }));
    for (const a of cards(el)) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toBe("noopener noreferrer");
      expect(a.querySelectorAll("a")).toHaveLength(0); // no nested links
    }
    expect(cards(el)[0].getAttribute("href")).toBe("https://www.decathlon.co.uk/");
    expect(cards(el)[1].getAttribute("aria-label")).toBe("Nike Pegasus 40 Running Shoes Mens at Sports Direct, £79.99, +£37.99 vs this listing, opens in a new tab");
    expect(cards(el)[0].getAttribute("aria-label")).toMatch(/, lowest price, opens in a new tab$/);
  });

  it("shows the placeholder when there is no thumbnail or it fails to load", () => {
    const data: NewOffers = { ...three, offers: three.offers.map((o, i) => (i === 0 ? { ...o, thumbnailUrl: THUMB } : o)) };
    const el = render(h(OfferCards, { data }));
    const img = cards(el)[0].querySelector("img")!;
    expect(img.getAttribute("src")).toBe(THUMB);
    expect(cards(el)[1].querySelector(".offer-thumb-none")).not.toBeNull(); // none given
    act(() => {
      img.dispatchEvent(new Event("error"));
    });
    expect(cards(el)[0].querySelector("img")).toBeNull();
    expect(cards(el)[0].querySelector(".offer-thumb-none")).not.toBeNull();
  });

  it("'Show all' appears only with more than 3 offers, and expands the list", () => {
    const button = (el: HTMLElement) => [...el.querySelectorAll("button")].find((b) => /Show all/.test(b.textContent ?? ""));
    expect(button(render(h(OfferCards, { data: three })))).toBeUndefined();
    act(() => root!.unmount());
    const el = render(h(OfferCards, { data: NEW_OFFERS }));
    expect(cards(el)).toHaveLength(3);
    const b = button(el)!;
    expect(b.textContent).toBe("Show all 4 offers");
    act(() => b.click());
    expect(cards(el)).toHaveLength(4);
  });

  it("with fewer than 3 retailers, shows the offers and says they aren't used for the verdict", () => {
    const el = render(h(OfferCards, { data: { ...NEW_OFFERS, enoughForComparison: false, offers: NEW_OFFERS.offers.slice(0, 2) } }));
    expect(cards(el)).toHaveLength(2);
    expect(el.textContent).toContain("Only 2 retailers found, so this isn't used for the price verdict.");
  });

  it("never renders a non-http(s) link", () => {
    const el = render(h(OfferCards, { data: { ...three, offers: [{ ...three.offers[0], url: "javascript:alert(1)" }, three.offers[1]] } }));
    expect(cards(el).map((a) => a.getAttribute("href"))).toEqual(["https://www.sportsdirect.com/"]);
  });

  it("difference wording in both directions", () => {
    expect(differenceText(3)).toBe("+£3 vs this listing");
    expect(differenceText(-4)).toBe("£4 cheaper than this listing");
    expect(differenceText(-3.5)).toBe("£3.50 cheaper than this listing");
    expect(differenceText(0)).toBe("Same price as this listing");
    expect(offerLabel({ ...three.offers[0], title: "Nike Pegasus 40", retailer: "Retailer", priceGBP: 45, differenceGBP: 3, isLowest: false })).toBe(
      "Nike Pegasus 40 at Retailer, £45, +£3 vs this listing, opens in a new tab",
    );
  });
});

describe("offer cards in the case file", () => {
  const props = { caseId: "cm0preview0042", listing: { title: "Nike Pegasus 40", priceGBP: 42 }, addEvidence: { busy: false, error: null, onCaptureTab: async () => null, onSubmit: () => undefined } };

  it("show in the Price exhibit, and again under 'Consider buying new' when that move exists", () => {
    expect(PANEL_BUY_NEW_ID).toBe(BUY_NEW_MOVE_ID);
    const el = render(h(CaseFile, { ...props, detail: CASE_FILE, initialOpen: ["price"] }));
    expect(cards(el)).toHaveLength(3);
    expect(el.querySelector(".buy-new")).toBeNull();
    act(() => root!.unmount());
    const move = { id: BUY_NEW_MOVE_ID, kind: "before_you_pay" as const, text: "Consider buying new: 4 UK retailers sell this model new, from £75.23.", relatesTo: ["price" as const] };
    const withMove = render(h(CaseFile, { ...props, detail: { ...CASE_FILE, nextMoves: [...CASE_FILE.nextMoves, move] } }));
    const buyNew = withMove.querySelector(".buy-new")!;
    expect(buyNew.textContent).toContain("4 UK retailers sell this model new, from £75.23.");
    expect(cards(buyNew as HTMLElement)).toHaveLength(3);
    expect([...withMove.querySelectorAll(".checklist li")].map((l) => l.textContent)).not.toContain(move.text); // not listed twice
  });
});

describe("live offers slot", () => {
  const at = (s: number) => 1000 + s * 1000;
  const ev = (name: IncomingEvent["name"], data: unknown, s = 0): IncomingEvent => ({ name, data, revision: 1, at: at(s) });
  const priceCheck = (newOffers?: NewOffers): CheckResult => ({ check: "price", status: "pass", summary: "s", evidence: [], confidence: 0.6, geminiFeatures: [], details: newOffers ? { newOffers } : {} });

  it("is reserved once the price check starts, fills on new_offers, and follows the finished check", () => {
    let s = newInvestigation(1, at(0));
    expect(offersSlot(s)).toEqual({ show: false, data: null });
    s = applyEvent(s, ev("stage_started", { stage: "price" }, 1));
    expect(offersSlot(s)).toEqual({ show: true, data: null });
    s = applyEvent(s, ev("new_offers", NEW_OFFERS, 2));
    expect(offersSlot(s)).toEqual({ show: true, data: NEW_OFFERS });
    s = applyEvent(s, ev("check_done", priceCheck(NEW_OFFERS), 3));
    expect(offersSlot(s)).toEqual({ show: true, data: NEW_OFFERS });
    // e.g. the version check made price unknown: its rerun carries no offers, so the cards go
    s = applyEvent(s, ev("check_done", priceCheck(), 4));
    expect(offersSlot(s)).toEqual({ show: false, data: null });
  });

  it("releases the slot when the price check ends without a Shopping lookup", () => {
    let s = applyEvent(newInvestigation(1, at(0)), ev("stage_started", { stage: "price" }, 1));
    s = applyEvent(s, ev("check_done", priceCheck(), 2));
    expect(offersSlot(s).show).toBe(false);
  });

  it("swaps the placeholder cards for real ones in the same reserved box", () => {
    const el = render(h(OffersSlot, { data: null }));
    const slot = el.querySelector(".offers-slot")!;
    expect(slot.getAttribute("aria-busy")).toBe("true");
    expect(slot.querySelectorAll(".offer-pending")).toHaveLength(3);
    act(() => root!.render(h(OffersSlot, { data: NEW_OFFERS })));
    expect(el.querySelector(".offers-slot")).toBe(slot); // same element: filled in place
    expect(slot.getAttribute("aria-busy")).toBe("false");
    expect(cards(slot as HTMLElement)).toHaveLength(3);
  });
});
