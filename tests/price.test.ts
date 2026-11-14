import { describe, expect, it } from "vitest";
import { agreeingCluster, decidePrice, parseNewPrices, shouldRunSourceB } from "@/pipeline/checks/price";
import type { SampleStats } from "@/schemas/domain";
import { grounded } from "./helpers";

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

describe("Source B parsing", () => {
  it("needs 2 sources agreeing within 15%", () => {
    expect(agreeingCluster([{ priceGBP: 100 }, { priceGBP: 112 }])).toEqual([0, 1]);
    expect(agreeingCluster([{ priceGBP: 100 }, { priceGBP: 130 }])).toBeNull();
    expect(agreeingCluster([{ priceGBP: 100 }])).toBeNull();
    expect(agreeingCluster([{ priceGBP: 60 }, { priceGBP: 120 }, { priceGBP: 125 }, { priceGBP: 119 }])?.length).toBe(3);
  });
  it("attributes prices only to grounded sources and drops resale sites", () => {
    const res = grounded([
      ["PRICE | SportsShoes | £119.99", ["sportsshoes.com"]],
      ["PRICE | Nike | £119.95", ["nike.com"]],
      ["PRICE | eBay | £60", ["ebay.co.uk"]],
      ["PRICE | Unsupported | £99", []],
    ]);
    const prices = parseNewPrices(res.text, res.groundingMetadata);
    expect(prices.map((p) => [p.domain, p.priceGBP])).toEqual([
      ["sportsshoes.com", 119.99],
      ["nike.com", 119.95],
    ]);
  });
});
