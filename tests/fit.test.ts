import { describe, expect, it } from "vitest";
import { applyReviewSizingNote, checkFit } from "@/pipeline/checks/fit";
import type { ListingFacts, UserNeeds } from "@/schemas/domain";
import { fixtureReference } from "./helpers";

const ref = fixtureReference();
const pegasus = ref.catalogue[0];
const facts = (sizeText?: string, sizeSystem?: ListingFacts["sizeSystem"]): ListingFacts => ({
  platform: "vinted",
  photoCount: 1,
  conditionClaims: [],
  sizeText,
  sizeSystem,
  evidence: sizeText ? [{ id: "ev_ext_1", kind: "quote", label: "Listed size", quote: sizeText }] : [],
});
const needs = (sizes: UserNeeds["sizes"]): UserNeeds => ({ sizes, priorities: [], wearTolerance: "light", extraPriorities: [], assumptions: [] });
const nike9 = needs([{ brand: "Nike", size: 9, system: "UK" }]);
const run = (f: ListingFacts, n: UserNeeds) => checkFit({ facts: f, needs: n, model: pegasus, charts: ref.sizeCharts });

describe("fit check", () => {
  it("exact match passes", () => {
    const r = run(facts("UK 9", "UK"), nike9);
    expect(r.status).toBe("pass");
    expect(r.details).toMatchObject({ match: "exact", listedSystem: "UK" });
    expect(r.evidence.map((e) => e.id)).toContain("ev_ext_1");
  });
  it("converts across systems on the same chart", () => {
    expect(run(facts("US 10", "US"), nike9).status).toBe("pass");
    expect(run(facts("EU 44", "EU"), nike9).status).toBe("pass");
  });
  it("half a size off warns", () => {
    const r = run(facts("UK 9.5", "UK"), nike9);
    expect(r.status).toBe("warn");
    expect(r.details?.match).toBe("close");
  });
  it("mismatch fails", () => {
    const r = run(facts("UK 7", "UK"), nike9);
    expect(r.status).toBe("fail");
    expect(r.details?.match).toBe("mismatch");
  });
  it("no listed size is unknown", () => {
    expect(run(facts(undefined), nike9).status).toBe("unknown");
  });
  it("no size for the brand: cross-brand estimate via cm is a warn", () => {
    const r = run(facts("UK 9", "UK"), needs([{ brand: "Adidas", size: 9.5, system: "UK" }]));
    expect(r.status).toBe("warn");
    expect(r.details?.match).toBe("estimated");
    expect(r.summary).toMatch(/Cross-brand estimate/);
  });
  it("cross-brand far off fails", () => {
    expect(run(facts("UK 6", "UK"), needs([{ brand: "Adidas", size: 10, system: "UK" }])).status).toBe("fail");
  });
  it("no saved sizes is unknown", () => {
    expect(run(facts("UK 9", "UK"), needs([])).status).toBe("unknown");
  });
  it("unstated listing system is assumed UK and capped at warn", () => {
    const r = run(facts("9", "unknown"), nike9);
    expect(r.status).toBe("warn");
    expect(r.details?.listedSystemAssumed).toBe(true);
  });
  it("review sizing advice turns a pass into warn", () => {
    const r = run(facts("UK 9", "UK"), nike9);
    const w = applyReviewSizingNote(r, "runs_small", "Reviewers say they run small.");
    expect(w.status).toBe("warn");
    expect(w.details?.reviewSizingNote).toBe("Reviewers say they run small.");
    expect(applyReviewSizingNote(r, "true_to_size", "TTS").status).toBe("pass");
    expect(applyReviewSizingNote(r, "unclear", undefined)).toBe(r);
  });
});
