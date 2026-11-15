import { describe, expect, it } from "vitest";
import { decideBadge, decideVerdict } from "@/pipeline/verdict/rules";
import { BANNED_WORDS, containsBanned, sentenceCount, validateNextMoveText, validateVerdictText } from "@/pipeline/verdict/validate";
import { decideAndWordVerdict, templateVerdictText } from "@/pipeline/verdict/wording";
import { indexEvidence } from "@/pipeline/util";
import type { CheckResult, VerdictLabel, WarningSignal } from "@/schemas/domain";
import { check } from "./helpers";

const allPass = (over: Partial<Record<string, Partial<CheckResult>>> = {}): CheckResult[] => [
  check({ check: "identify", status: "pass", ...over.identify }),
  check({ check: "fit", status: "pass", ...over.fit }),
  check({ check: "price", status: "pass", details: { position: "below" }, ...over.price }),
  check({ check: "comfort", status: "pass", ...over.comfort }),
  check({ check: "condition", status: "pass", details: { findings: [] }, ...over.condition }),
];

const signal = (strength: WarningSignal["strength"], confidence = 0.8): WarningSignal => ({
  id: "off_platform",
  strength,
  text: "The listing asks to move payment off-platform.",
  evidence: [{ id: `ev_signal_${strength}`, kind: "quote", label: "Listing text", quote: "Pay outside the app" }],
  confidence,
  relatesTo: ["price"],
});

describe("verdict rules", () => {
  it("R1: identify not passed", () => expect(decideVerdict(allPass(), false)).toEqual({ label: "not_enough_evidence", ruleId: "R1" }));
  it("R2: fit fail", () => expect(decideVerdict(allPass({ fit: { status: "fail" } }), true).ruleId).toBe("R2"));
  it("R3: price fail", () => expect(decideVerdict(allPass({ price: { status: "fail" } }), true)).toEqual({ label: "overpriced", ruleId: "R3" }));
  it("R4: one strong or two medium signals", () => {
    expect(decideVerdict(allPass(), true, [signal("strong")])).toEqual({ label: "proceed_with_caution", ruleId: "R4" });
    expect(decideVerdict(allPass(), true, [signal("medium"), signal("medium")]).ruleId).toBe("R4");
    expect(decideVerdict(allPass(), true, [signal("medium")]).ruleId).toBe("R8");
  });
  it("R5: condition fail and R6: any warn or unknown", () => {
    expect(decideVerdict(allPass({ condition: { status: "fail" } }), true).ruleId).toBe("R5");
    expect(decideVerdict(allPass({ comfort: { status: "warn" } }), true).ruleId).toBe("R6");
    expect(decideVerdict(allPass({ comfort: { status: "unknown" } }), true).ruleId).toBe("R6");
    expect(decideVerdict(allPass().filter((c) => c.check !== "comfort"), true).ruleId).toBe("R6"); // missing = unknown
  });
  it("R7: all pass, price below, no finding above minor and no signals", () => {
    expect(decideVerdict(allPass({ condition: { status: "pass", details: { findings: [{ severity: "minor" }] } } }), true)).toEqual({ label: "hidden_gem", ruleId: "R7" });
  });
  it("R8: otherwise, including one medium signal", () => {
    expect(decideVerdict(allPass({ price: { status: "pass", details: { position: "typical" } } }), true)).toEqual({ label: "worth_a_look", ruleId: "R8" });
    expect(decideVerdict(allPass({ condition: { status: "pass", details: { findings: [{ severity: "moderate" }] } } }), true).ruleId).toBe("R8");
    expect(decideVerdict(allPass(), true, [signal("medium")]).ruleId).toBe("R8");
  });
  it("ordering: first match wins", () => {
    const all = allPass({ fit: { status: "fail" }, price: { status: "fail" }, condition: { status: "fail" }, comfort: { status: "warn" } });
    expect(decideVerdict(all, false).ruleId).toBe("R1");
    expect(decideVerdict(all, true).ruleId).toBe("R2");
    expect(decideVerdict(allPass({ price: { status: "fail" }, condition: { status: "fail" } }), true).ruleId).toBe("R3");
    expect(decideVerdict(allPass({ condition: { status: "fail" }, comfort: { status: "warn" } }), true).ruleId).toBe("R5");
    expect(decideVerdict(allPass({ price: { status: "fail" } }), true, [signal("strong")]).ruleId).toBe("R3");
  });
});

describe("badge", () => {
  it("out_sleuthed only for hidden_gem with confidence >= 0.7 (price >= 0.6)", () => {
    const checks = allPass({ price: { confidence: 0.6 } });
    expect(decideBadge("hidden_gem", checks)).toBe("out_sleuthed");
    expect(decideBadge("worth_a_look", checks)).toBeNull();
    expect(decideBadge("hidden_gem", allPass({ price: { confidence: 0.59 } }))).toBeNull();
    expect(decideBadge("hidden_gem", allPass({ comfort: { confidence: 0.69 } }))).toBeNull();
  });
});

describe("banned words", () => {
  it.each([...BANNED_WORDS, "Scammer", "faked", "ripoff", "rip off", "guarantee"])("catches %s", (w) => {
    expect(containsBanned(`This looks like a ${w} to me`)).toBe(true);
  });
  it("does not flag innocent words", () => {
    expect(containsBanned("Pay through the platform for buyer protection.")).toBe(false);
  });
});

describe("verdict validator", () => {
  const checks = allPass({
    price: { status: "warn", summary: "At £38 it's unusually low (compared with 12 listings sampled on 3–10 Nov).", evidence: [{ id: "ev_price_1", kind: "data_point", label: "Compared with 12 listings sampled on 3–10 Nov" }] },
  });
  const evidence = indexEvidence(...checks.map((c) => c.evidence));
  const ok = { headline: "Cheap for a reason?", explanation: "At £38 it sits below the 12 sampled listings. Ask about faults before paying.", citedEvidenceIds: ["ev_price_1"] };

  it("accepts valid text", () => expect(validateVerdictText(ok, { checks, evidence })).toEqual([]));
  it("rejects unknown evidence ids", () => {
    expect(validateVerdictText({ ...ok, citedEvidenceIds: ["ev_nope"] }, { checks, evidence }).join()).toMatch(/do not exist/);
  });
  it("rejects when a warn/fail check is not mentioned", () => {
    const errs = validateVerdictText({ headline: "Fine.", explanation: "All good here. Nothing more to add.", citedEvidenceIds: ["ev_fit_1"] }, { checks, evidence });
    expect(errs.join()).toMatch(/price check/);
  });
  it("rejects numbers not in the evidence", () => {
    expect(validateVerdictText({ ...ok, explanation: "At £25 it sits below sampled listings. Ask about faults." }, { checks, evidence }).join()).toMatch(/Numbers not found/);
  });
  it("rejects price claims without a source", () => {
    expect(validateVerdictText({ ...ok, explanation: "The price is low. Ask about faults before paying." }, { checks, evidence }).join()).toMatch(/where they come from/);
  });
  it("rejects banned words and bad sentence counts", () => {
    expect(validateVerdictText({ ...ok, headline: "Possible scam" }, { checks, evidence }).join()).toMatch(/Banned/);
    expect(validateVerdictText({ ...ok, explanation: "One sentence about sampled listings." }, { checks, evidence }).join()).toMatch(/2-4 sentences/);
    expect(sentenceCount("One. Two! Three?")).toBe(3);
  });
  it("next-move validator", () => {
    expect(validateNextMoveText("Could you share a photo of the soles?", "ask_seller")).toEqual([]);
    expect(validateNextMoveText("Are these fake?", "ask_seller").length).toBeGreaterThan(0);
    expect(validateNextMoveText("Prove it, are you lying?", "ask_seller").join()).toMatch(/Accusatory/);
    expect(validateNextMoveText("Send a photo of the soles.", "ask_seller").join()).toMatch(/question mark/);
  });
});

describe("wording", () => {
  const labels: VerdictLabel[] = ["hidden_gem", "worth_a_look", "proceed_with_caution", "overpriced", "wrong_fit", "not_enough_evidence"];
  it.each(labels)("template for %s passes the validator", (label) => {
    const checks = allPass({
      fit: { status: label === "wrong_fit" ? "fail" : "pass", summary: "Listed UK 7 is 2 sizes smaller than your Nike size." },
      price: { status: label === "overpriced" ? "fail" : "pass", summary: "At £38 it's below most comparable listings (compared with 12 listings sampled on 3–10 Nov, median £46.5).", details: { position: "below" } },
      comfort: { status: label === "proceed_with_caution" ? "warn" : "pass", summary: "Only 1 independent review found, so comfort for your needs isn't well established." },
      identify: { status: label === "not_enough_evidence" ? "unknown" : "pass", summary: "I couldn't identify the exact model from the photos and text." },
    });
    const t = templateVerdictText(label, checks);
    expect(validateVerdictText(t, { checks, evidence: indexEvidence(...checks.map((c) => c.evidence)) })).toEqual([]);
  });
  it("falls back to the template when Gemini text fails validation twice; label never changes", async () => {
    let calls = 0;
    const gemini = {
      async generate() {
        calls++;
        return { text: JSON.stringify({ headline: "A scam", explanation: "Bad.", citedEvidenceIds: [] }), functionCalls: [], model: "m", cached: false };
      },
    };
    const checks = allPass({ price: { details: { position: "typical" } } });
    const { verdict, usedTemplate } = await decideAndWordVerdict(gemini, { checks, identifyPassed: true });
    expect(calls).toBe(2);
    expect(usedTemplate).toBe(true);
    expect(verdict.label).toBe("worth_a_look");
    expect(containsBanned(verdict.headline + verdict.explanation)).toBe(false);
  });
  it("uses signal evidence and wording in the deterministic caution template", async () => {
    const checks = allPass({ price: { summary: "Compared with sampled listings on 10 Nov.", evidence: [{ id: "ev_price_signal", kind: "data_point", label: "Compared with sampled listings on 10 Nov" }] } });
    const s = signal("strong");
    const { verdict } = await decideAndWordVerdict(null, { checks, identifyPassed: true, signals: [s] });
    expect(verdict).toMatchObject({ label: "proceed_with_caution", ruleId: "R4" });
    expect(verdict.citedEvidenceIds).toContain("ev_signal_strong");
    expect(verdict.explanation).toContain("move payment off-platform");
    expect(validateVerdictText(verdict, { checks, evidence: indexEvidence(...checks.map((c) => c.evidence), s.evidence) })).toEqual([]);
  });
});
