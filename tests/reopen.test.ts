import { describe, expect, it } from "vitest";
import { affectedChecks, diffCases, mergeReplyFacts, type ReplyFacts } from "@/pipeline/reopen";
import type { ListingFacts } from "@/schemas/domain";
import { check } from "./helpers";

const reply = (r: Partial<ReplyFacts>): ReplyFacts => ({ conditionStatements: [], answers: [], ...r });

describe("affected-check mapping", () => {
  it("new image -> condition", () => expect([...affectedChecks({ newImages: true, imageShowsLabel: false })]).toEqual(["condition"]));
  it("new image with a label -> condition + identify (+ fit if it shows a size)", () => {
    expect(affectedChecks({ newImages: true, imageShowsLabel: true })).toEqual(new Set(["condition", "identify"]));
    expect(affectedChecks({ newImages: true, imageShowsLabel: true, labelHasSize: true })).toEqual(new Set(["condition", "identify", "fit"]));
  });
  it("seller reply fields map to their checks", () => {
    expect([...affectedChecks({ newImages: false, imageShowsLabel: false, reply: reply({ sizeText: "UK 9" }) })]).toEqual(["fit"]);
    expect([...affectedChecks({ newImages: false, imageShowsLabel: false, reply: reply({ price: 40 }) })]).toEqual(["price"]);
    expect([...affectedChecks({ newImages: false, imageShowsLabel: false, reply: reply({ conditionStatements: ["no damage"] }) })]).toEqual(["condition"]);
    expect([...affectedChecks({ newImages: false, imageShowsLabel: false, reply: reply({ modelText: "Pegasus 40" }) })]).toEqual(["identify"]);
    expect(affectedChecks({ newImages: false, imageShowsLabel: false, reply: reply({}) }).size).toBe(0);
  });
});

describe("mergeReplyFacts", () => {
  const facts: ListingFacts = {
    platform: "vinted",
    photoCount: 1,
    conditionClaims: ["Good"],
    sizeText: "9",
    sizeSystem: "unknown",
    priceGBP: 40,
    evidence: [{ id: "ev_ext_1", kind: "quote", label: "Listed size", quote: "9" }],
  };
  it("replaces size with the seller's quoted words and appends condition statements", () => {
    const merged = mergeReplyFacts(facts, reply({ sizeText: "UK 9", sizeSystem: "UK", conditionStatements: ["No marks on the soles"] }), "They're UK 9. No marks on the soles.", 2);
    expect(merged.sizeText).toBe("UK 9");
    expect(merged.sizeSystem).toBe("UK");
    expect(merged.evidence.find((e) => e.label.startsWith("Listed size"))).toMatchObject({ kind: "quote", quote: "UK 9", id: "ev_reply2_1" });
    expect(merged.evidence.some((e) => e.id === "ev_ext_1")).toBe(false);
    expect(merged.conditionClaims).toEqual(["Good", "No marks on the soles"]);
    expect(merged.priceGBP).toBe(40);
  });
});

describe("diffCases", () => {
  it("reports only rerun checks whose status or summary changed", () => {
    const before = [check({ check: "fit", status: "unknown" }), check({ check: "price", status: "pass" }), check({ check: "condition", status: "warn" })];
    const after = [check({ check: "fit", status: "pass" }), check({ check: "price", status: "pass" }), check({ check: "condition", status: "warn" })];
    const d = diffCases({ fromRevision: 1, toRevision: 2, before, after, rerun: new Set(["fit", "condition"]), reasons: { fit: "Seller gave the size" }, verdictBefore: "proceed_with_caution", verdictAfter: "worth_a_look" });
    expect(d).toEqual({ fromRevision: 1, toRevision: 2, checks: [{ check: "fit", before: "unknown", after: "pass", reason: "Seller gave the size" }], verdict: { before: "proceed_with_caution", after: "worth_a_look" } });
  });
});
