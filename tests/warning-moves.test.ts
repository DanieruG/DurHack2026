import { describe, expect, it } from "vitest";
import { generateNextMoves } from "@/pipeline/nextMoves";
import type { CheckResult, WarningSignal } from "@/schemas/domain";

const checks: CheckResult[] = [
  { check: "identify", status: "pass", summary: "Identified.", evidence: [], confidence: 0.9, geminiFeatures: [] },
  { check: "fit", status: "pass", summary: "Fits.", evidence: [], confidence: 0.9, geminiFeatures: [] },
  { check: "price", status: "pass", summary: "Price checked.", evidence: [], confidence: 0.8, geminiFeatures: [], details: { listingPriceGBP: 38 } },
  { check: "comfort", status: "pass", summary: "Comfort checked.", evidence: [], confidence: 0.8, geminiFeatures: [] },
  { check: "condition", status: "pass", summary: "Condition checked.", evidence: [], confidence: 0.8, geminiFeatures: [], details: { notVisible: ["size label", "insole"], photos: [] } },
];

const signal: WarningSignal = {
  id: "off_platform",
  strength: "strong",
  text: "The listing asks to move payment off-platform.",
  evidence: [],
  confidence: 0.9,
  relatesTo: ["price"],
};

describe("warning next moves", () => {
  it("puts platform buyer protection first and adds the missing-photo question outside the normal cap", async () => {
    const moves = await generateNextMoves(null, {
      checks,
      leads: [],
      label: "worth_a_look",
      signals: [signal, { id: "expected_photos_missing", strength: "mild", text: "Missing photos.", evidence: [], confidence: 0.75, relatesTo: ["condition"] }],
      platform: "ebay",
    });
    expect(moves[0]).toEqual({ id: "nm_signal_protection", kind: "before_you_pay", text: "Pay through eBay so buyer protection applies.", relatesTo: [] });
    expect(moves.find((m) => m.id === "nm_signal_photos")).toMatchObject({ kind: "ask_seller", text: "Could you share a clear photo of the size label inside the tongue and the insole?" });
    expect(moves.filter((m) => m.kind === "before_you_pay").map((m) => m.id)).not.toContain("byp_protection");
  });

  it("adds the high-value authenticity move without requiring a signal", async () => {
    const moves = await generateNextMoves(null, {
      checks: checks.map((c) => (c.check === "price" ? { ...c, details: { listingPriceGBP: 150 } } : c)),
      leads: [],
      label: "worth_a_look",
      platform: "vinted",
    });
    expect(moves.find((m) => m.id === "nm_authenticity_check")).toEqual({
      id: "nm_authenticity_check",
      kind: "before_you_pay",
      text: "Check whether Vinted offers an authenticity check for this item before you pay.",
      relatesTo: ["condition", "identify"],
    });
  });

  it("keeps the ordinary protection wording when no signal fires", async () => {
    const moves = await generateNextMoves(null, { checks, leads: [], label: "hidden_gem", platform: "vinted" });
    expect(moves.find((m) => m.kind === "before_you_pay" && m.text.includes("buyer protection"))?.text).toContain("buyer protection");
  });
});
