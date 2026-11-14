import { describe, expect, it } from "vitest";
import { createNewPriceClient, filterOffers, rejectReason, shoppingCacheKey, shoppingQuery, titleMatchesModel, SHOPPING_CACHE_TTL_MS } from "@/lib/newPrices";
import { MemoryStore } from "@/lib/store";
import { fakeNewPrices, fixtureReference, shoppingFixture } from "./helpers";

// Saved SerpApi google_shopping responses (gl=uk) from 2026-11-14, trimmed to the fields we use.
const dropset = shoppingFixture("adidas-dropset-3");
const pegasus = shoppingFixture("nike-pegasus-40");
// Hand-made: accessories, kids, used/refurbished flag, non-GBP, marketplaces and a retailer listed twice.
const edge = shoppingFixture("constructed-edge-cases");

describe("new prices: filter", () => {
  it("excludes second-hand marketplaces and resale platforms (eBay, StockX, GOAT, Vinted, Gumtree)", () => {
    const sellers = (rs: typeof dropset) => rs.filter((r) => rejectReason(r, { brand: "Adidas", modelName: "Dropset 3" }) === "marketplace").map((r) => r.source);
    expect(new Set(sellers(dropset))).toEqual(new Set(["StockX", "GOAT", "eBay", "eBay - branded-outlet1"]));
    const kept = filterOffers(edge, { brand: "Nike", modelName: "Pegasus 40" }).map((o) => o.retailer);
    expect(kept).not.toContain("Vinted");
    expect(kept).not.toContain("Gumtree");
  });

  it("excludes a different model version (Dropset 4, Pegasus 41/42) and other models sharing the name", () => {
    expect(titleMatchesModel("adidas Dropset 4 Men's Training Shoes", "Adidas", "Dropset 3")).toBe(false);
    expect(titleMatchesModel("adidas Dropset 2 size 3", "Adidas", "Dropset 3")).toBe(false);
    expect(titleMatchesModel("adidas Men's Adizero Dropset Pro Shoes", "Adidas", "Dropset 3")).toBe(false);
    expect(titleMatchesModel("adidas Women's Dropset 3 Shoes", "Adidas", "Dropset 3")).toBe(true);
    expect(titleMatchesModel("Nike Pegasus 41 Men's Running Shoes", "Nike", "Pegasus 40")).toBe(false);
    expect(titleMatchesModel("Sneakers Nike Air Zoom Pegasus 40 Black", "Nike", "Pegasus 40")).toBe(true);
    const titles = filterOffers(pegasus, { brand: "Nike", modelName: "Pegasus 40" }).map((o) => o.title);
    for (const t of titles) expect(t).toMatch(/Pegasus 40\b/);
  });

  it("excludes accessories, kids' versions (unless the listing is for kids), used/refurbished and non-GBP prices", () => {
    const args = { brand: "Nike", modelName: "Pegasus 40" };
    const why = Object.fromEntries(edge.map((r) => [r.source, rejectReason(r, args)]));
    expect(why).toMatchObject({ "Insole Shop": "accessory", "Lace Co": "accessory", Schuh: "kids", "Runner Outlet": "used", "US Store": "price", Vinted: "marketplace", Gumtree: "marketplace" });
    expect(rejectReason(edge.find((r) => r.source === "Schuh")!, { ...args, kids: true })).toBeNull();
  });

  it("keeps one offer per retailer, its lowest price", () => {
    const jd = filterOffers(edge, { brand: "Nike", modelName: "Pegasus 40" }).filter((o) => o.retailer === "JD Sports");
    expect(jd).toEqual([expect.objectContaining({ priceGBP: 95 })]);
    const ubuy = filterOffers(dropset, { brand: "Adidas", modelName: "Dropset 3" }).filter((o) => o.retailer === "u-buy.co.uk");
    expect(ubuy.map((o) => o.priceGBP)).toEqual([66]); // five u-buy listings -> one, the cheapest
  });

  it("needs at least 3 offers: Dropset 3 has 2 (unavailable), Pegasus 40 has 3 (median £89.99)", async () => {
    const { client } = fakeNewPrices({ "Adidas Dropset 3": dropset, "Nike Pegasus 40": pegasus });
    const d = await client.getNewPrices("Dropset 3", "Adidas");
    expect(d).toMatchObject({ available: false, medianGBP: null, lowestGBP: null, rawResults: 40 });
    expect(d.offers.map((o) => [o.retailer, o.priceGBP])).toEqual([["MandM", 44.99], ["u-buy.co.uk", 66]]);
    const p = await client.getNewPrices("Pegasus 40", "Nike");
    expect(p).toMatchObject({ available: true, medianGBP: 89.99, lowestGBP: 75.23, checkedOn: "2026-11-14" });
    expect(p.offers.map((o) => o.retailer)).toEqual(["Shopsprees", "Decathlon UK", "FARFETCH"]);
  });
});

describe("new prices: client", () => {
  const store = () => new MemoryStore(fixtureReference());

  it("queries '{brand} {modelName}' with gl=uk and caches the response for 24 hours", async () => {
    const s = store();
    let now = new Date("2026-11-14T12:00:00Z");
    const { client, requests } = fakeNewPrices({ "Nike Pegasus 40": pegasus }, { store: s, now: () => now });
    await client.getNewPrices("Pegasus 40", "Nike");
    await client.getNewPrices("Pegasus 40", "Nike");
    expect(requests).toEqual(["Nike Pegasus 40"]);
    expect(await s.cacheGet(shoppingCacheKey("Nike Pegasus 40", "uk"))).toMatchObject({ fetchedAt: "2026-11-14T12:00:00.000Z" });
    now = new Date(now.getTime() + SHOPPING_CACHE_TTL_MS + 1);
    await client.getNewPrices("Pegasus 40", "Nike");
    expect(requests).toHaveLength(2); // expired -> refetched
  });

  it("replay mode serves the cache (even when stale) and never calls the network", async () => {
    const s = store();
    await s.cacheSet(shoppingCacheKey(shoppingQuery("Nike", "Pegasus 40")), { fetchedAt: "2026-01-01T00:00:00.000Z", results: pegasus });
    let networkCalls = 0;
    const client = createNewPriceClient({
      apiKey: "test-key",
      mode: "replay",
      store: s,
      now: () => new Date("2026-11-14T12:00:00Z"),
      logger: () => undefined,
      fetch: async () => {
        networkCalls++;
        throw new Error("network must not be used in replay mode");
      },
    });
    expect((await client.getNewPrices("Pegasus 40", "Nike")).medianGBP).toBe(89.99);
    await expect(client.getNewPrices("Dropset 3", "Adidas")).rejects.toThrow(/replay mode/);
    expect(networkCalls).toBe(0);
  });

  it("retries once on 5xx/429, not on 4xx; never puts the key in logs or errors", async () => {
    const logs: string[] = [];
    const statuses = [503, 200, 429, 429, 401];
    let calls = 0;
    const client = createNewPriceClient({
      apiKey: "SECRET-KEY-123",
      mode: "off",
      store: store(),
      logger: (l) => logs.push(l),
      retryBackoffMs: 1,
      fetch: async () => {
        const status = statuses[calls++];
        return { ok: status === 200, status, json: async () => ({ shopping_results: pegasus }) };
      },
    });
    expect((await client.getNewPrices("Pegasus 40", "Nike")).available).toBe(true); // 503 then 200
    await expect(client.getNewPrices("Dropset 3", "Adidas")).rejects.toThrow("HTTP 429"); // 429, 429
    await expect(client.getNewPrices("Samba OG", "Adidas")).rejects.toThrow("HTTP 401"); // no retry
    expect(calls).toBe(5);
    expect(logs).toEqual([expect.stringMatching(/^\[shopping\] provider=serpapi q="Nike Pegasus 40" gl=uk raw=40 kept=3 \d+ms$/)]);
    expect(logs.join("\n")).not.toContain("SECRET-KEY-123");
  });

  it("times out after the request timeout", async () => {
    const client = createNewPriceClient({
      apiKey: "k",
      mode: "off",
      store: store(),
      timeoutMs: 20,
      fetch: (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("t"), { name: "TimeoutError" })))),
    });
    await expect(client.getNewPrices("Pegasus 40", "Nike")).rejects.toThrow("timed out after 20ms");
  });
});
