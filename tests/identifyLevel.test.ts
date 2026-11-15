import { describe, expect, it } from "vitest";
import { assignLevel, normaliseIdentify, withLevel } from "@/pipeline/identifyLevel";
import { brandKnown, subjectOf, toIdentifyResult } from "@/pipeline/identify";
import { couldAlsoBe, identifyLabel } from "@/lib/identifyLabel";
import { IdentifyResultSchema, type IdentifyResult } from "@/schemas/domain";
import { fixtureReference } from "./helpers";

const cat = fixtureReference().catalogue;
const facts = { platform: "vinted" as const, conditionClaims: [], photoCount: 3, evidence: [] };
const base = { confidence: 0.9, hasModel: true, styleCodeRead: false, listingNamesModel: false, conflicting: false, proDisagrees: false };

describe("assignLevel", () => {
  it("confirmed: a style code or the listing naming the exact model, with nothing conflicting", () => {
    expect(assignLevel({ ...base, styleCodeRead: true })).toBe("confirmed");
    expect(assignLevel({ ...base, listingNamesModel: true })).toBe("confirmed");
    expect(assignLevel({ ...base, listingNamesModel: true, conflicting: true })).toBe("possible");
  });
  it("likely at 0.75 and above with no conflict; possible 0.5 to 0.75; best_guess below 0.5", () => {
    expect(assignLevel(base)).toBe("likely");
    expect(assignLevel({ ...base, confidence: 0.75 })).toBe("likely");
    expect(assignLevel({ ...base, confidence: 0.74 })).toBe("possible");
    expect(assignLevel({ ...base, confidence: 0.5 })).toBe("possible");
    expect(assignLevel({ ...base, confidence: 0.49 })).toBe("best_guess");
    expect(assignLevel({ ...base, conflicting: true })).toBe("possible");
  });
  it("Flash and Pro disagreeing is possible, however confident; no model at all is best_guess", () => {
    expect(assignLevel({ ...base, proDisagrees: true, styleCodeRead: true })).toBe("possible");
    expect(assignLevel({ ...base, hasModel: false })).toBe("best_guess");
  });
});

describe("withLevel", () => {
  const result = (over: Partial<IdentifyResult> = {}): IdentifyResult => ({ brand: "Nike", brandConfidence: 0.9, modelName: "Pegasus 40", catalogueModelId: "nike-pegasus-40", inCatalogue: true, confidence: 0.9, reasons: "", evidence: [], ...over });
  it("reads 'the listing names the model' from the title, not from the rest of the page", () => {
    expect(withLevel(result(), { facts: { ...facts, title: "Nike Pegasus 40 trainers" }, pageText: "", catalogue: cat }).confidenceLevel).toBe("confirmed");
    expect(withLevel(result(), { facts: { ...facts, title: "Nike trainers" }, pageText: "similar items: Nike Pegasus 40", catalogue: cat }).confidenceLevel).toBe("likely");
  });
  it("a clearly read style code confirms; photos naming a different model conflict", () => {
    expect(withLevel(result(), { facts: { ...facts, styleCode: "DV3853-001" }, pageText: "", catalogue: cat }).confidenceLevel).toBe("confirmed");
    expect(withLevel(result({ photoModel: { modelName: "Pegasus 41", confidence: 0.8 } }), { facts, pageText: "", catalogue: cat }).confidenceLevel).toBe("possible");
  });
  it("never overwrites user_confirmed", () => {
    expect(withLevel(result({ confidenceLevel: "user_confirmed", confidence: 0.2 }), { facts, pageText: "", catalogue: cat }).confidenceLevel).toBe("user_confirmed");
  });
});

describe("toIdentifyResult", () => {
  const wire = { brand: "nike", brandConfidence: 0.8, modelName: "Air Max 95", version: "Essential", colourway: "Black", catalogueModelId: null, confidence: 0.6, reasons: "r", evidence: [], photoModel: null };
  const args = { shortlist: [], catalogue: cat, pageText: "", photoCount: 1 };
  it("builds the best guess and up to 2 alternatives, ordered by confidence, without repeating the best guess", () => {
    const r = toIdentifyResult(
      {
        ...wire,
        alternatives: [
          { modelName: "Air Max 95", version: "OG", confidence: 0.3, reason: "colour" },
          { modelName: "Air Max 90", confidence: 0.4 },
          { modelName: "Air Max 95", version: "Essential", confidence: 0.5 },
        ].slice(0, 2),
      },
      args,
    );
    expect(r.bestGuess).toMatchObject({ model: "Air Max 95", version: "Essential", colourway: "Black", confidence: 0.6 });
    expect(r.alternatives!.map((a) => [a.model, a.version])).toEqual([["Air Max 90", null], ["Air Max 95", "OG"]]);
    expect(subjectOf(r, cat)).toMatchObject({ tier: "model", modelName: "Air Max 95 Essential", displayName: "Nike Air Max 95 Essential" });
  });
  it("brand only, with the reason, when Gemini suggests no model", () => {
    const r = toIdentifyResult({ ...wire, modelName: null, version: null, noModelReason: "Only a swoosh is visible", alternatives: [] }, args);
    expect(r).toMatchObject({ bestGuess: { brand: r.brand, model: null }, brandOnlyReason: "Only a swoosh is visible" });
    expect(subjectOf(r, cat).tier).toBe("brand");
    expect(brandKnown(r, cat)).toBe(true);
  });
  it("brand unknown: R1 territory", () => {
    expect(brandKnown(toIdentifyResult({ ...wire, brand: null, brandConfidence: 0, modelName: null, alternatives: [] }, args), cat)).toBe(false);
  });
});

describe("labels", () => {
  const r = (over: Partial<IdentifyResult>): IdentifyResult => ({
    inCatalogue: false,
    brand: "Nike",
    brandConfidence: 0.9,
    modelName: "Air Max 95",
    catalogueModelId: null,
    confidence: 0.8,
    reasons: "",
    evidence: [],
    bestGuess: { brand: "Nike", model: "Air Max 95", version: "Essential", colourway: null, confidence: 0.8, evidence: [] },
    alternatives: [{ brand: "Nike", model: "Air Max 95", version: "OG", colourway: null, confidence: 0.4, evidence: [] }],
    ...over,
  });
  it("words each level", () => {
    expect(identifyLabel(r({ confidenceLevel: "confirmed" }))).toBe("Nike Air Max 95 Essential");
    expect(identifyLabel(r({ confidenceLevel: "likely" }))).toBe("Likely Nike Air Max 95 Essential");
    expect(identifyLabel(r({ confidenceLevel: "possible" }))).toBe("Possibly Nike Air Max 95 Essential or OG");
    expect(identifyLabel(r({ confidenceLevel: "best_guess", bestGuess: { brand: "Nike", model: "Air Max 95", version: null, colourway: null, confidence: 0.3, evidence: [] } }))).toBe("Best guess: Nike Air Max 95 (version unclear)");
    expect(identifyLabel(r({ confidenceLevel: "user_confirmed" }))).toBe("Nike Air Max 95 Essential (confirmed by you)");
    expect(couldAlsoBe(r({}))).toBe("Could also be: Nike Air Max 95 OG");
  });
});

describe("normaliseIdentify: old stored cases stay readable", () => {
  const old = IdentifyResultSchema.parse({ brand: "Nike", brandConfidence: 0.9, modelName: "Pegasus 40", catalogueModelId: "nike-pegasus-40", inCatalogue: true, confidence: 0.9, reasons: "r", evidence: [] });
  it("derives the best guess and level from the old fields", () => {
    expect(normaliseIdentify(old)).toMatchObject({ confidenceLevel: "likely", bestGuess: { brand: "Nike", model: "Pegasus 40", confidence: 0.9 }, alternatives: [] });
    expect(normaliseIdentify({ ...old, confidence: 0.6 })!.confidenceLevel).toBe("possible");
    expect(normaliseIdentify({ ...old, modelName: null, catalogueModelId: null, confidence: 0 })!.confidenceLevel).toBe("best_guess");
  });
  it("old family-tier cases become possible, with the second version as an alternative", () => {
    const fam = normaliseIdentify({ ...old, modelName: "Pegasus", catalogueModelId: null, versionUnclear: { family: "Pegasus", options: ["40", "41"] } })!;
    expect(fam).toMatchObject({ confidenceLevel: "possible", alternatives: [{ model: "Pegasus 41" }] });
  });
  it("is idempotent and null-safe", () => {
    const once = normaliseIdentify(old)!;
    expect(normaliseIdentify(once)).toEqual(once);
    expect(normaliseIdentify(null)).toBeNull();
  });
});
