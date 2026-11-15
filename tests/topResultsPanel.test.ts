// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { CaseFile } from "@/extension/src/panel/screens/CaseFile";
import { CaseReady } from "@/extension/src/panel/screens/CaseReady";
import { Investigating } from "@/extension/src/panel/screens/Investigating";
import { SearchSurvey } from "@/extension/src/panel/screens/SearchSurvey";
import { CASE_FILE, PROFILE } from "@/extension/src/preview/fixtures";
import { applyEvent, newInvestigation } from "@/extension/src/lib/progress";
import { topResultsForCase, type SurveyCard, type SurveyRecord } from "@/extension/src/lib/survey";
import { topResults } from "@/extension/src/lib/topResults";
import { ProfileScreen } from "@/extension/src/panel/screens/Profile";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});
async function render(el: ReturnType<typeof h>) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(el));
  return host;
}

let n = 0;
const card = (over: Partial<SurveyCard> = {}): SurveyCard => {
  n++;
  return {
    id: String(3000 + n),
    title: "Nike Pegasus 40 trainers",
    price: 40,
    currency: "GBP",
    url: `https://www.vinted.co.uk/items/${3000 + n}-nike`,
    thumbnailUrl: `https://images1.vinted.net/t/${3000 + n}/a.webp`,
    sizeText: "UK 9",
    sponsored: false,
    priceBasis: "excl_buyer_protection",
    seenAt: "2026-11-14T10:00:00.000Z",
    ...over,
  };
};
const cards = [card({ price: 22 }), card({ price: 28 }), card({ price: 35 }), card({ price: 44 }), card({ price: 50 }), card({ price: 60 })];
const record: SurveyRecord = { key: "vinted:nike pegasus 40", platform: "vinted", query: "nike pegasus 40", createdAt: "2026-11-14T10:00:00.000Z", updatedAt: "2026-11-14T10:00:00.000Z", cards };
const NOW = Date.parse("2026-11-14T12:00:00Z");
const click = (el: Element) => act(() => (el as HTMLElement).click());

describe("the search page screen", () => {
  const page = { platform: "vinted" as const, query: "nike pegasus 40", key: "vinted:nike pegasus 40" };
  it("lists the top results with thumbnail, price, size, reason and a link, with no click needed", async () => {
    const top = topResults(cards, { profile: PROFILE, query: "nike pegasus 40" });
    const onInvestigate = vi.fn();
    const el = await render(h(SearchSurvey, { page, summary: "Surveyed 6 listings", added: null, busy: false, error: null, onSurvey: vi.fn(), top, onInvestigate }));
    expect(el.textContent).toContain("Top results from this search");
    const links = [...el.querySelectorAll<HTMLAnchorElement>("a[href^='https://www.vinted.co.uk/items/']")];
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(el.querySelector("img")?.getAttribute("src")).toContain("images1.vinted.net");
    expect(el.textContent).toMatch(/£22/);
    expect(el.textContent).toMatch(/under typical/);
    expect(el.textContent).toContain("UK 9");
    const investigate = [...el.querySelectorAll("button")].find((b) => b.textContent === "Investigate")!;
    click(investigate);
    expect(onInvestigate).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/www\.vinted\.co\.uk\/items\//));
  });
  it("says it is reading the page until something has been read, and no longer asks for a click first", async () => {
    const el = await render(h(SearchSurvey, { page, summary: null, added: null, busy: false, error: null, onSurvey: vi.fn(), top: [] }));
    expect(el.textContent).toContain("Reading the results on this page");
    expect(el.textContent).toContain("reads the results on this page by itself");
    expect(el.textContent).not.toContain("Survey these results");
  });
});

describe("Other high-potential results in the case file", () => {
  const props = { caseId: CASE_FILE.id, listing: { title: "Nike Pegasus 40", priceGBP: 42 }, addEvidence: { busy: false, error: null, onCaptureTab: async () => null, onSubmit: () => undefined } };
  const block = topResultsForCase([record], { platform: "vinted", pageUrl: "https://www.vinted.co.uk/items/3001-nike", profile: PROFILE, now: NOW })!;

  it("is built from the local survey for the case's platform, without the listing itself", () => {
    expect(block.results.length).toBeGreaterThan(0);
    expect(block.results.every((r) => r.card.id !== "3001")).toBe(true);
    expect(block.footnote).toContain("Vinted search for “nike pegasus 40”");
    expect(topResultsForCase([record], { platform: "ebay", pageUrl: null, profile: null, now: NOW })).toBeNull();
    expect(topResultsForCase([record], { platform: "vinted", pageUrl: null, profile: null, now: NOW + 25 * 3600_000 })).toBeNull(); // expired
    expect(topResultsForCase([record], { platform: "other", pageUrl: null, profile: null, now: NOW })).toBeNull();
  });

  it("is visible straight away, not inside the collapsed Price row, with links", async () => {
    const el = await render(h(CaseFile, { ...props, detail: CASE_FILE, topResults: block }));
    const section = el.querySelector("section.top-results")!;
    expect(section.querySelector("h2, .label, p")?.textContent).toBeTruthy();
    expect(section.textContent).toContain("Other high-potential results");
    expect(section.querySelectorAll("a[href^='https://www.vinted.co.uk/items/']").length).toBeGreaterThan(0);
    // Not nested in an evidence row, and placed above the evidence rows.
    expect(section.closest(".evidence")).toBeNull();
    const evidence = el.querySelector("section.evidence")!;
    expect(section.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("is absent without a survey", async () => {
    const el = await render(h(CaseFile, { ...props, detail: CASE_FILE, topResults: null }));
    expect(el.querySelector("section.top-results")).toBeNull();
  });

  it("also shows while the case is running or waiting for the buyer", async () => {
    const inv = applyEvent(newInvestigation(1, 0), {
      name: "identity_check_needed",
      revision: 1,
      at: 1,
      data: { level: "possible", headline: "Possibly Nike Pegasus 40", bestGuess: { brand: "Nike", model: "Pegasus 40", version: null, colourway: null, label: "Nike Pegasus 40", confidence: 0.6, evidence: [] }, alternatives: [], lensMatches: [], waiting: ["price", "comfort"] },
    });
    const el = await render(h(Investigating, { caseId: CASE_FILE.id, title: "t", inv, onConfirm: vi.fn(), topResults: block }));
    expect(el.querySelector(".identity-card")).not.toBeNull();
    expect(el.querySelector("section.top-results")?.textContent).toContain("Other high-potential results");
  });
});

describe("the colour box and the renamed questions", () => {
  const state = { kind: "listing" as const, preview: { title: "Nike Pegasus 40", priceGBP: 42, platform: "vinted" as const, photoCount: 3, pageUrl: "https://www.vinted.co.uk/items/123-nike", thumbnail: null } };
  it("has its own 'Colour or look' box, sent with the investigation, apart from the note", async () => {
    const onInvestigate = vi.fn();
    const el = await render(h(CaseReady, { state: state as never, profile: PROFILE, onFile: null, busy: false, error: null, onInvestigate, onOpenCase: vi.fn(), onEditProfile: vi.fn(), onAllow: vi.fn() }));
    const colour = el.querySelector<HTMLInputElement>("#case-colour")!;
    expect(el.querySelector('label[for="case-colour"]')?.textContent).toBe("Colour or look");
    expect(colour.placeholder).toBe("e.g. all white, retro, nothing neon");
    expect(el.querySelector('label[for="case-note"]')?.textContent).toBe("Anything else about this pair?");
    expect(el.textContent).toContain("Put colour in the box above.");
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(colour, "all white");
      colour.dispatchEvent(new Event("input", { bubbles: true }));
    });
    click([...el.querySelectorAll("button")].find((b) => b.textContent === "Investigate")!);
    expect(onInvestigate).toHaveBeenCalledWith("", "all white");
  });
  it("the profile asks for comfort and fit priorities, not 'Priorities'", async () => {
    const el = await render(h(ProfileScreen, { profile: PROFILE, apiBase: "http://localhost:3000", firstRun: false, onSave: vi.fn(), onCancel: vi.fn() } as never));
    expect(el.textContent).toContain("Comfort and fit priorities");
    expect(el.textContent).toContain("Colour goes on each case instead.");
  });
});

describe("the Colour row", () => {
  const props = { caseId: CASE_FILE.id, listing: { title: "Nike Pegasus 40", priceGBP: 42 }, addEvidence: { busy: false, error: null, onCaptureTab: async () => null, onSubmit: () => undefined } };
  const colour = {
    check: "colour" as const,
    status: "warn" as const,
    summary: "It may not meet what you asked for (all white, nothing neon). A neon heel tab.",
    evidence: [{ id: "ev_colour_1", kind: "data_point" as const, label: "Listing colour: Colour field: \"white\"" }],
    confidence: 0.7,
    geminiFeatures: [],
    details: { wish: "all white, nothing neon", requirements: [{ text: "all white", verdict: "meets", note: "The listing is white (from the listing's colour field)." }, { text: "nothing neon", verdict: "doesnt", note: "A neon heel tab." }] },
  };
  it("shows what was asked for and each requirement's verdict, between Fit and Comfort", async () => {
    const el = await render(h(CaseFile, { ...props, detail: { ...CASE_FILE, checks: [...CASE_FILE.checks, colour] }, initialOpen: ["colour"] }));
    expect(el.textContent).toContain("You asked for: all white, nothing neon");
    expect(el.textContent).toContain("Meets: all white");
    expect(el.textContent).toContain("Doesn't meet: nothing neon");
    const names = [...el.querySelectorAll(".evidence .row-name, .evidence button")].map((b) => b.textContent ?? "").join("|");
    expect(names.indexOf("Colour")).toBeGreaterThan(-1);
  });
  it("isn't shown when the buyer didn't ask for a colour", async () => {
    const el = await render(h(CaseFile, { ...props, detail: CASE_FILE }));
    expect(el.textContent).not.toContain("You asked for");
  });
});

describe("Show next 8", () => {
  const page = { platform: "vinted" as const, query: "nike pegasus 40", key: "vinted:nike pegasus 40" };
  const many = Array.from({ length: 20 }, (_, i) => card({ id: `m${String(i).padStart(2, "0")}`, price: 20 + i * 0.5 }));
  const ranked = topResults(many, { profile: PROFILE, query: "nike pegasus 40", limit: 40 });
  const titlesShown = (el: HTMLElement) => [...el.querySelectorAll(".offer-list li a")].map((a) => a.getAttribute("href"));
  const nextBtn = (el: HTMLElement) => [...el.querySelectorAll("button")].find((b) => /^Show next/.test(b.textContent ?? ""));

  it("shows 8 at a time, pages forward and back, and says where you are", async () => {
    expect(ranked.length).toBeGreaterThan(8);
    const el = await render(h(SearchSurvey, { page, summary: "Surveyed 20 listings", added: null, busy: false, error: null, onSurvey: vi.fn(), top: ranked }));
    const first = titlesShown(el);
    expect(first).toHaveLength(8);
    expect(el.textContent).toContain(`1-8 of ${ranked.length}`);
    click(nextBtn(el)!);
    const second = titlesShown(el);
    expect(second.length).toBeGreaterThan(0);
    expect(second.some((u) => first.includes(u))).toBe(false); // different listings
    expect(el.textContent).toContain(`9-${Math.min(16, ranked.length)} of ${ranked.length}`);
    click([...el.querySelectorAll("button")].find((b) => b.textContent === "Back to top")!);
    expect(titlesShown(el)).toEqual(first);
  });
  it("no pager when everything fits on one page", async () => {
    const el = await render(h(SearchSurvey, { page, summary: "x", added: null, busy: false, error: null, onSurvey: vi.fn(), top: ranked.slice(0, 5) }));
    expect(nextBtn(el)).toBeUndefined();
  });
  it("always explains what was read, even when nothing ranks", async () => {
    const counts = { read: 58, ranked: 0, sponsored: 4, auctions: 5, unpriced: 3, otherCurrency: 0, self: 0, aboveTypical: 20, otherSize: 26, typicalGBP: 44, colourWanted: [], colourMatched: 0, colourOther: 0, photosChecked: 0 };
    const el = await render(h(SearchSurvey, { page, summary: "Surveyed 58 listings", added: null, busy: false, error: null, onSurvey: vi.fn(), top: [], counts }));
    expect(el.querySelector(".results-explain")?.textContent).toBe("Read 58 listings. None stood out as good value; left out: 26 not in your size, 20 above the typical £44, 9 auctions or sponsored, 3 with no single price.");
  });
});

describe("colour or look on the search screen", () => {
  const page = { platform: "vinted" as const, query: "nike pegasus 40", key: "vinted:nike pegasus 40" };
  const base = { page, summary: "Surveyed 20 listings", added: null, busy: false, error: null, onSurvey: vi.fn(), top: [] as never[] };
  const type = (el: HTMLElement, value: string) =>
    act(() => {
      const input = el.querySelector<HTMLInputElement>("#search-colour")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });

  it("asks before a listing is picked, and re-ranks after a short pause (not on every key)", async () => {
    vi.useFakeTimers();
    try {
      const onColour = vi.fn();
      const el = await render(h(SearchSurvey, { ...base, colour: "", onColour }));
      expect(el.querySelector('label[for="search-colour"]')?.textContent).toBe("Colour or look");
      type(el, "all");
      type(el, "all white");
      expect(onColour).not.toHaveBeenCalled();
      act(() => void vi.advanceTimersByTime(450));
      expect(onColour).toHaveBeenCalledTimes(1);
      expect(onColour).toHaveBeenCalledWith("all white");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a saved colour for this search, and says when it is checking photos", async () => {
    const el = await render(h(SearchSurvey, { ...base, colour: "navy", onColour: vi.fn(), photoProgress: { done: 12, total: 24 } }));
    expect(el.querySelector<HTMLInputElement>("#search-colour")!.value).toBe("navy");
    expect(el.textContent).toContain("Checking photos 12/24");
  });

  it("is not shown by screens that don't take colour (older callers)", async () => {
    const el = await render(h(SearchSurvey, base));
    expect(el.querySelector("#search-colour")).toBeNull();
  });

  it("the colour is already filled in when you go on to investigate, and is sent with it", async () => {
    const state = { kind: "listing" as const, preview: { title: "Nike Pegasus 40", priceGBP: 42, platform: "vinted" as const, photoCount: 3, pageUrl: "https://www.vinted.co.uk/items/123-nike", thumbnail: null } };
    const onInvestigate = vi.fn();
    const el = await render(h(CaseReady, { state: state as never, profile: PROFILE, onFile: null, busy: false, error: null, onInvestigate, onOpenCase: vi.fn(), onEditProfile: vi.fn(), onAllow: vi.fn(), defaultColour: "all white" }));
    expect(el.querySelector<HTMLInputElement>("#case-colour")!.value).toBe("all white");
    click([...el.querySelectorAll("button")].find((b) => b.textContent === "Investigate")!);
    expect(onInvestigate).toHaveBeenCalledWith("", "all white");
  });
});
