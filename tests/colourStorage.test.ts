import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadColourWishes, loadThumbColours, saveColourWish, saveSurveyCards, saveThumbColours } from "@/extension/src/chrome/storage";
import { SURVEY_TTL_MS, searchPageOf, type SurveyCard } from "@/extension/src/lib/survey";

/** A tiny in-memory chrome.storage.local. */
let store: Record<string, unknown> = {};
beforeEach(() => {
  store = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get: async (k: string | string[]) => Object.fromEntries((Array.isArray(k) ? k : [k]).filter((x) => x in store).map((x) => [x, store[x]])),
        set: async (o: Record<string, unknown>) => void Object.assign(store, o),
        remove: async (k: string | string[]) => void (Array.isArray(k) ? k : [k]).forEach((x) => delete store[x]),
      },
    },
  };
});
afterEach(() => delete (globalThis as { chrome?: unknown }).chrome);

const NOW = Date.parse("2026-11-14T12:00:00Z");
const card = (id: string): SurveyCard => ({ id, title: "Nike Pegasus 40", price: 30, currency: "GBP", url: `https://www.vinted.co.uk/items/${id}-x`, sponsored: false, priceBasis: "excl_buyer_protection", seenAt: new Date(NOW).toISOString() });

describe("colour wishes per search", () => {
  it("are kept per search, cleared by an empty one, and expire with the survey TTL", async () => {
    await saveColourWish("vinted:nike pegasus 40", "  all white ", NOW);
    await saveColourWish("ebay:nike pegasus 40", "navy", NOW - SURVEY_TTL_MS - 1000);
    expect(await loadColourWishes(NOW)).toEqual({ "vinted:nike pegasus 40": "all white" });
    await saveColourWish("vinted:nike pegasus 40", "   ", NOW);
    expect(await loadColourWishes(NOW)).toEqual({});
  });
  it("don't touch the surveys the background worker writes", async () => {
    const page = searchPageOf("https://www.vinted.co.uk/catalog?search_text=nike+pegasus+40")!;
    await saveSurveyCards(page, [card("1")], NOW);
    await saveColourWish(page.key, "white", NOW);
    expect((store.surveys as { cards: unknown[] }[])[0].cards).toHaveLength(1);
    await saveSurveyCards(page, [card("1"), card("2")], NOW + 1000);
    expect(await loadColourWishes(NOW + 1000)).toEqual({ [page.key]: "white" });
  });
});

describe("thumbnail colour cache", () => {
  it("keeps readings only for cards still surveyed", async () => {
    const page = searchPageOf("https://www.vinted.co.uk/catalog?search_text=nike+pegasus+40")!;
    await saveSurveyCards(page, [card("1")], NOW);
    const e = (t: number) => ({ u: "x", c: [["white", 0.8]] as [string, number][], m: false, t });
    await saveThumbColours({ "1": e(NOW), "gone": e(NOW) });
    expect(Object.keys(await loadThumbColours(NOW))).toEqual(["1"]);
  });
});
