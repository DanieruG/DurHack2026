import { describe, expect, it } from "vitest";
import { createCase } from "@/pipeline";
import type { NextMove } from "@/schemas/domain";
import type { RawShoppingResult } from "@/lib/newPrices";
import { candidatesAgree } from "@/pipeline/checks/price";
import { checksFrom, json, makeDeps, PAGE_TEXT, PROFILE, type Handler } from "./helpers";

/** Three UK retailers selling a model at about `gbp` (the shopping filter needs 3+ offers whose titles match). */
const offers = (name: string, gbp: number): RawShoppingResult[] =>
  ["Retailer A", "Retailer B", "Retailer C"].map((source, i) => ({
    title: `Nike ${name}`,
    source,
    price: `£${gbp + i}.00`,
    extracted_price: gbp + i,
    product_link: `https://shop.example.com/${source.replace(/\s/g, "")}/${name.replace(/\s/g, "-")}`,
  }));

const identifyAt = (confidence: number): Handler => () =>
  json({
    catalogueModelId: "nike-pegasus-40",
    confidence,
    reasons: "Looks like the 40",
    evidence: [{ kind: "quote", label: "Title", quote: "Nike Air Zoom Pegasus 40" }],
    alternatives: [{ modelName: "Pegasus 41", confidence: 0.4, reason: "Similar sole" }],
  });

async function run(identify: Handler, shopping: Record<string, RawShoppingResult[]>) {
  const deps = makeDeps({ handlers: { identify }, shopping, webSearch: {} });
  const { caseId, done } = await createCase(deps, { capture: { pageText: PAGE_TEXT, imageUrls: ["https://img.example.com/1.jpg"] }, profile: PROFILE, screenshots: [] });
  await done;
  const events = deps.hub.events(caseId);
  return { deps, events, checks: checksFrom(events), c: (await deps.store.getCase(caseId))! };
}

describe("model-dependent checks on a best guess (possible / best_guess)", () => {
  it("price is conditional on the best guess and stays unknown when the candidates' new prices differ by more than 15%", async () => {
    const { checks, deps } = await run(identifyAt(0.6), { "Nike Pegasus 40": offers("Pegasus 40", 100), "Nike Pegasus 41": offers("Pegasus 41", 130) });
    expect(checks.price.status).toBe("unknown");
    expect(checks.price.summary).toMatch(/^If this is the Nike Pegasus 40, it's £101 new\./);
    expect(checks.price.details).toMatchObject({ conditional: true, conditionalOn: [{ model: "Nike Pegasus 40", newGBP: 101 }, { model: "Nike Pegasus 41", newGBP: 131 }] });
    expect(checks.price.confidence).toBe(0);
    expect(deps.shoppingRequests).toContain("Nike Pegasus 41");
  });

  it("when every candidate's new price is within 15%, the range is used with confidence at most 0.4", async () => {
    const { checks } = await run(identifyAt(0.6), { "Nike Pegasus 40": offers("Pegasus 40", 100), "Nike Pegasus 41": offers("Pegasus 41", 110) });
    expect(checks.price.status).not.toBe("unknown");
    expect(checks.price.confidence).toBeGreaterThan(0);
    expect(checks.price.confidence).toBeLessThanOrEqual(0.4);
    expect(checks.price.summary).toMatch(/^If this is the Nike Pegasus 40 or the Nike Pegasus 41, it's £101–£111 new\./);
    expect(checks.price.details).toMatchObject({ conditional: true, candidateRange: { low: 101, high: 111 } });
  });

  it("the 15% rule: dearest within 15% of the cheapest", () => {
    expect(candidatesAgree([100])).toBe(true);
    expect(candidatesAgree([100, 115])).toBe(true);
    expect(candidatesAgree([100, 115.01])).toBe(false);
    expect(candidatesAgree([100, 108, 114])).toBe(true);
    expect(candidatesAgree([])).toBe(false);
  });

  it("comfort says it's based on the best guess", async () => {
    const { checks } = await run(identifyAt(0.6), {});
    expect(checks.comfort.summary).toMatch(/^Based on our best guess: Nike Pegasus 40\./);
    expect(checks.comfort.details).toMatchObject({ basedOnBestGuess: true });
  });

  it("a best_guess (below 0.5) is treated the same way, and fit still runs on the brand's chart", async () => {
    const { checks, c } = await run(identifyAt(0.3), { "Nike Pegasus 40": offers("Pegasus 40", 100) });
    expect(c.identify!.confidenceLevel).toBe("best_guess");
    expect(checks.identify.summary).toMatch(/^Best guess: Nike Pegasus 40/);
    expect(checks.price.details).toMatchObject({ conditional: true });
    expect(checks.fit.status).toBe("pass");
  });

  it("next moves ask for the tongue or size label", async () => {
    const { c } = await run(identifyAt(0.6), {});
    const ask = (c.nextMoves as NextMove[]).find((m) => m.kind === "ask_seller" && m.relatesTo.includes("identify"));
    expect(ask?.text).toMatch(/tongue/);
  });

  it("a likely identification is not conditional and comfort isn't labelled", async () => {
    const { checks } = await run(identifyAt(0.8), { "Nike Pegasus 40": offers("Pegasus 40", 100) });
    expect(checks.price.details).not.toHaveProperty("conditional");
    expect(checks.comfort.summary).not.toMatch(/best guess/);
  });
});

