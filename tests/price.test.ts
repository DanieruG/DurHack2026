import { describe, expect, it } from "vitest";
import { checkPrice, decidePrice, NOT_IN_SAMPLE_NOTE, shouldRunSourceB } from "@/pipeline/checks/price";
import { summariseOffers, type NewPrices } from "@/lib/newPrices";
import type { ListingFacts, SampleStats } from "@/schemas/domain";
import { fixtureReference } from "./helpers";

const sample: SampleStats = { n: 12, excluded: 0, median: 50, p10: 30, p25: 40, p75: 60, p90: 70, collectedOn: { from: "2026-11-03", to: "2026-11-10" }, ruleIds: ["R-newest-N"], placeholder: false };
const newPrice = { gbp: 120 };

describe("price status table", () => {
  it.each([
    ["neither source", { price: 50, sample: null, newPrice: null }, "unknown", null],
    ["at or above new", { price: 120, sample, newPrice }, "fail", "at_or_above_new"],
    ["above p90", { price: 75, sample, newPrice: null }, "fail", "above"],
    ["below p10", { price: 25, sample, newPrice: null }, "warn", "suspiciously_low"],
    ["at or below p25", { price: 40, sample, newPrice: null }, "pass", "below"],
    ["typical", { price: 55, sample, newPrice: null }, "pass", "typical"],
    ["B only, <= 60% of new", { price: 72, sample: null, newPrice }, "pass", "below"],
    ["B only, above 60% of new", { price: 80, sample: null, newPrice }, "pass", "typical"],
  ] as const)("%s", (_, input, status, position) => {
    const d = decidePrice(input);
    expect(d.status).toBe(status);
    expect(d.position).toBe(position);
  });
  it("new-price rule beats the sample rules (order)", () => {
    expect(decidePrice({ price: 130, sample, newPrice }).position).toBe("at_or_above_new");
  });
  it("over budget is at least warn", () => {
    expect(decidePrice({ price: 40, sample, newPrice: null, budgetGBP: 35 })).toMatchObject({ status: "warn", position: "below", overBudget: true });
    expect(decidePrice({ price: 75, sample, newPrice: null, budgetGBP: 35 }).status).toBe("fail");
  });
  it("runs Source B when A is unavailable or the price is high", () => {
    expect(shouldRunSourceB(40, null)).toBe(true);
    expect(shouldRunSourceB(40, sample)).toBe(false);
    expect(shouldRunSourceB(60, sample)).toBe(true);
  });
});

const needs = { sizes: [], priorities: [], wearTolerance: "light" as const, extraPriorities: [], assumptions: [] };
const facts = (priceGBP: number) => ({ platform: "ebay", photoCount: 1, conditionClaims: [], priceGBP, evidence: [] }) as ListingFacts;
const offer = (retailer: string, priceGBP: number) => ({ retailer, priceGBP, url: `https://example.test/${retailer}`, title: `adidas Dropset 3 (${retailer})` });
const prices = (offers: ReturnType<typeof offer>[]): NewPrices => summariseOffers(offers, { checkedOn: "2026-11-14", query: "Adidas Dropset 3", rawResults: 40 });
const notInCatalogue = { id: null, brand: "Adidas", name: "Dropset 3" };

describe("price Source B: Google Shopping new price", () => {
  it("uses the median of the retailer offers as the new price, with a summary data point and one source per offer", async () => {
    const r = await checkPrice({
      facts: facts(40),
      needs,
      model: notInCatalogue,
      samples: [],
      lookupNewPrices: async () => prices([offer("MandM", 70), offer("Next", 75), offer("JD", 80), offer("Schuh", 90)]),
    });
    expect(r.status).toBe("pass");
    expect(r.details).toMatchObject({ position: "below", newPrice: { gbp: 77.5, lowestGBP: 70, sources: 4, observedOn: "2026-11-14" }, inCatalogue: false });
    expect(r.evidence[0]).toMatchObject({ kind: "data_point", label: "New price £77.50, median of 4 UK retailers, checked 14 Nov", sourceType: "retailer" });
    expect(r.evidence.slice(1)).toHaveLength(4);
    for (const e of r.evidence.slice(1)) expect(e).toMatchObject({ kind: "source", sourceType: "retailer", observedOn: "2026-11-14", url: expect.stringMatching(/^https:/), title: expect.any(String) });
    expect(r.summary.startsWith(NOT_IN_SAMPLE_NOTE)).toBe(true);
    expect(r.confidence).toBe(0.45); // outside the catalogue: capped
    expect(r.geminiFeatures).toEqual([]);
  });

  it("confidence 0.7 with 5+ offers, 0.6 with 3-4 (catalogue model without a sample)", async () => {
    const run = (n: number) =>
      checkPrice({ facts: facts(40), needs, model: { id: "nike-pegasus-40", brand: "Nike", name: "Pegasus 40" }, samples: [], lookupNewPrices: async () => prices(Array.from({ length: n }, (_, i) => offer(`R${i}`, 100 + i))) });
    expect((await run(5)).confidence).toBe(0.7);
    expect((await run(3)).confidence).toBe(0.6);
  });

  it("fewer than 3 offers: new price unavailable, plain summary", async () => {
    const r = await checkPrice({ facts: facts(40), needs, model: { id: "nike-pegasus-40", brand: "Nike", name: "Pegasus 40" }, samples: [], lookupNewPrices: async () => prices([offer("MandM", 45), offer("u-buy", 66)]) });
    expect(r).toMatchObject({ status: "unknown", summary: "I couldn't find enough current UK retailer prices for this model.", confidence: 0 });
    expect(r.details).toMatchObject({ retailerOffers: 2, sourceBRun: true });
    expect(r.details).not.toHaveProperty("newPrice");
  });

  it("at or above the median new price fails (spec 7.6 rules unchanged)", async () => {
    const r = await checkPrice({ facts: facts(90), needs, model: notInCatalogue, samples: [], lookupNewPrices: async () => prices([offer("A", 80), offer("B", 85), offer("C", 90)]) });
    expect(r).toMatchObject({ status: "fail", details: { position: "at_or_above_new" } });
  });

  it("a failed lookup leaves the sample to decide; function_calling only when Gemini called the tool", async () => {
    const ref = fixtureReference();
    const r = await checkPrice({
      facts: facts(58),
      needs,
      model: ref.catalogue[0],
      samples: ref.priceSamples,
      lookupNewPrices: async () => {
        throw new Error("HTTP 500");
      },
      calledViaTool: () => true,
    });
    expect(r.status).not.toBe("unknown");
    expect(r.details).not.toHaveProperty("newPrice");
    expect(r.geminiFeatures).toEqual(["function_calling"]);
  });
});
