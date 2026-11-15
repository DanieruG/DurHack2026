import { describe, expect, it } from "vitest";
import { createAutoSurvey, RESCAN_DELAYS_MS, type AutoSurveyDeps } from "@/extension/src/lib/autoSurvey";
import type { RawSearchCapture, SearchPage, SurveyCard } from "@/extension/src/lib/survey";

const SEARCH = "https://www.vinted.co.uk/catalog?search_text=nike+pegasus+40";
const EBAY = "https://www.ebay.co.uk/sch/i.html?_nkw=nike+pegasus+40";
const LISTING = "https://www.vinted.co.uk/items/123-nike-pegasus";

const raw = (pageUrl = SEARCH): RawSearchCapture => ({
  pageUrl,
  embedded: { json: [], scripts: [] },
  cards: [
    { href: "https://www.vinted.co.uk/items/111-nike-pegasus-40", title: "Nike Pegasus 40", priceText: "£30.00", img: "https://images1.vinted.net/t/1/a.webp", sizeText: "UK 9", condition: null, sponsored: false, format: "unknown", summary: null },
    { href: "https://www.vinted.co.uk/items/112-nike-pegasus-40", title: "Nike Pegasus 40", priceText: "£34.00", img: "https://images1.vinted.net/t/2/a.webp", sizeText: "UK 9", condition: null, sponsored: false, format: "unknown", summary: null },
  ],
});

/** A fake clock: timers run in order when advanced. */
function harness(over: Partial<AutoSurveyDeps> & { urls?: Record<number, string> } = {}) {
  const timers: { at: number; fn: () => void; id: number; live: boolean }[] = [];
  let now = 0;
  let next = 1;
  const saved: { page: SearchPage; cards: SurveyCard[] }[] = [];
  const reads: number[] = [];
  const urls: Record<number, string> = over.urls ?? {};
  const auto = createAutoSurvey({
    read: over.read ?? (async (tabId) => (reads.push(tabId), raw(urls[tabId]))),
    save: async (page, cards) => void saved.push({ page, cards }),
    urlOf: async (tabId) => urls[tabId] ?? null,
    schedule: (fn, ms) => {
      const t = { at: now + ms, fn, id: next++, live: true };
      timers.push(t);
      return t.id;
    },
    cancel: (h) => {
      const t = timers.find((x) => x.id === h);
      if (t) t.live = false;
    },
    now: () => new Date("2026-11-14T10:00:00Z"),
  });
  const advance = async (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => x.live && x.at <= now).sort((a, b) => a.at - b.at)) {
      t.live = false;
      t.fn();
      await new Promise((r) => setTimeout(r, 0));
    }
  };
  return { auto, advance, saved, reads, urls };
}

describe("auto-survey on search pages", () => {
  it("reads a search results page shortly after it loads, and again after the results have rendered", async () => {
    const h = harness({ urls: { 1: SEARCH } });
    h.auto.onTabUpdated(1, SEARCH);
    expect(h.reads).toEqual([]); // not before the page has had a moment
    await h.advance(RESCAN_DELAYS_MS[0]);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0].page).toMatchObject({ platform: "vinted", query: "nike pegasus 40", key: "vinted:nike pegasus 40" });
    expect(h.saved[0].cards.map((c) => [c.price, c.url])).toEqual([[30, "https://www.vinted.co.uk/items/111-nike-pegasus-40"], [34, "https://www.vinted.co.uk/items/112-nike-pegasus-40"]]);
    await h.advance(RESCAN_DELAYS_MS[1]);
    expect(h.saved).toHaveLength(2);
  });

  it("works for eBay searches too", async () => {
    const h = harness({ urls: { 2: EBAY }, read: async () => ({ ...raw(EBAY), cards: [{ href: "https://www.ebay.co.uk/itm/2051234567?hash=x", title: "Nike Pegasus 40", priceText: "£35.00", img: "https://i.ebayimg.com/images/g/a/s-l500.jpg", sizeText: null, condition: null, sponsored: false, format: "buy_it_now", summary: null }] }) });
    h.auto.onTabUpdated(2, EBAY);
    await h.advance(RESCAN_DELAYS_MS[0]);
    expect(h.saved[0].page.platform).toBe("ebay");
    expect(h.saved[0].cards[0]).toMatchObject({ price: 35, url: "https://www.ebay.co.uk/itm/2051234567" });
  });

  it("ignores pages that aren't search results", async () => {
    const h = harness({ urls: { 3: LISTING } });
    h.auto.onTabUpdated(3, LISTING);
    h.auto.onTabUpdated(4, "https://example.com/");
    h.auto.onTabUpdated(5, undefined);
    expect(h.auto.pendingTabs()).toEqual([]);
    await h.advance(60_000);
    expect(h.saved).toEqual([]);
  });

  it("repeated tab events reset the timers instead of piling up scans", async () => {
    const h = harness({ urls: { 1: SEARCH } });
    for (let i = 0; i < 5; i++) h.auto.onTabUpdated(1, SEARCH);
    await h.advance(60_000);
    expect(h.saved).toHaveLength(RESCAN_DELAYS_MS.length);
  });

  it("navigating away before the scan cancels it; a tab that moved to a listing is not read", async () => {
    const h = harness({ urls: { 1: SEARCH } });
    h.auto.onTabUpdated(1, SEARCH);
    h.urls[1] = LISTING; // the tab navigated; the scheduled scan re-checks the URL
    await h.advance(60_000);
    expect(h.saved).toEqual([]);
    const g = harness({ urls: { 1: SEARCH } });
    g.auto.onTabUpdated(1, SEARCH);
    g.auto.onTabUpdated(1, LISTING); // the next event is a listing: the pending scans are dropped
    await g.advance(60_000);
    expect(g.reads).toEqual([]);
    g.auto.onTabUpdated(1, SEARCH);
    g.auto.onTabRemoved(1);
    expect(g.auto.pendingTabs()).toEqual([]);
  });

  it("failures are silent: unreadable page, no cards yet, a throwing save", async () => {
    const unreadable = harness({ urls: { 1: SEARCH }, read: async () => null });
    unreadable.auto.onTabUpdated(1, SEARCH);
    await unreadable.advance(60_000);
    expect(unreadable.saved).toEqual([]);
    const empty = harness({ urls: { 1: SEARCH }, read: async () => ({ ...raw(), cards: [] }) });
    expect(await empty.auto.scan(1)).toBe(0);
    const throwing = createAutoSurvey({ read: async () => raw(), save: async () => { throw new Error("storage full"); }, urlOf: async () => SEARCH, schedule: () => 0, cancel: () => undefined });
    expect(await throwing.scan(1)).toBe(0);
  });

  it("a scan right away reports how many cards it kept", async () => {
    const h = harness({ urls: { 1: SEARCH } });
    expect(await h.auto.scan(1)).toBe(2);
  });
});
