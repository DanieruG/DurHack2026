import { describe, expect, it } from "vitest";
import { redact } from "@/lib/redact";
import { detectWarningSignals } from "@/pipeline/signals";
import type { CheckResult, IdentifyResult, ListingFacts } from "@/schemas/domain";

const facts = (over: Partial<ListingFacts> = {}): ListingFacts => ({
  title: "Nike Pegasus 40",
  brandText: "Nike",
  modelText: "Pegasus 40",
  priceGBP: 40,
  platform: "vinted",
  conditionClaims: ["Good"],
  photoCount: 2,
  evidence: [],
  ...over,
});

const check = (over: Partial<CheckResult> & Pick<CheckResult, "check">): CheckResult => ({
  status: "pass",
  summary: "All clear.",
  evidence: [],
  confidence: 0.8,
  geminiFeatures: [],
  ...over,
});

const baseChecks = (priceDetails: Record<string, unknown> = {}, conditionDetails: Record<string, unknown> = {}) => [
  check({ check: "identify" }),
  check({ check: "fit" }),
  check({ check: "price", details: { listingPriceGBP: 40, ...priceDetails } }),
  check({ check: "comfort" }),
  check({ check: "condition", details: { findings: [], notVisible: [], ...conditionDetails } }),
];

const identify: IdentifyResult = {
  brand: "Nike",
  brandConfidence: 0.95,
  modelName: "Pegasus 40",
  catalogueModelId: "nike-pegasus-40",
  inCatalogue: true,
  confidence: 0.9,
  reasons: "Title",
  evidence: [],
};

function signals(over: Partial<Parameters<typeof detectWarningSignals>[0]> = {}) {
  return detectWarningSignals({
    checks: baseChecks(),
    facts: facts(),
    identify,
    pageText: "",
    platform: "vinted",
    ...over,
  });
}

describe("warning signals", () => {
  it("detects off-platform contact and payment requests", () => {
    expect(signals({ pageText: "Pay by bank transfer or WhatsApp me." }).map((s) => s.id)).toContain("off_platform");
    expect(signals({ sellerReplies: ["Use PayPal F&F please."] }).map((s) => s.id)).toContain("off_platform");
  });

  it("does not treat cash on collection or plain PayPal as off-platform", () => {
    expect(signals({ pageText: "Cash on collection only. PayPal accepted." }).map((s) => s.id)).not.toContain("off_platform");
  });

  it("does not fire for a negated off-platform phrase", () => {
    expect(signals({ pageText: "No PayPal F&F. Pay through Vinted." }).map((s) => s.id)).not.toContain("off_platform");
  });

  it("detects redacted phone and email placeholders without retaining contact details", () => {
    const redacted = redact("Message me on 020 7946 0958 or jane@example.com").text;
    expect(redacted).toContain("[phone number removed]");
    expect(redacted).toContain("[email removed]");
    const signal = signals({ pageText: redacted }).find((s) => s.id === "off_platform");
    expect(signal?.evidence[0].quote).toContain("[phone number removed]");
    expect(signal?.evidence[0].quote).not.toMatch(/020|jane@example/);
  });

  it("detects a price far below sampled listings or current new price", () => {
    expect(signals({ checks: baseChecks({ sample: { n: 8, p10: 50, p90: 80 } }) }).map((s) => s.id)).toContain("price_far_below");
    expect(signals({ checks: baseChecks({ newPrice: { gbp: 150 } }) }).map((s) => s.id)).toContain("price_far_below");
  });

  it("requires enough sample data and does not flag an ordinary low price", () => {
    expect(signals({ checks: baseChecks({ sample: { n: 4, p10: 50, p90: 80 } }) }).map((s) => s.id)).not.toContain("price_far_below");
    expect(signals({ checks: baseChecks({ sample: { n: 8, p10: 30, p90: 80 } }) }).map((s) => s.id)).not.toContain("price_far_below");
  });

  it("detects new at a low price but not like-new or New Balance", () => {
    expect(signals({ facts: facts({ conditionClaims: ["Brand new"] }), checks: baseChecks({ newPrice: { gbp: 100 } }) }).map((s) => s.id)).toContain("new_at_low_price");
    expect(signals({ facts: facts({ conditionClaims: ["Like new"] }), checks: baseChecks({ newPrice: { gbp: 100 } }) }).map((s) => s.id)).not.toContain("new_at_low_price");
    expect(signals({ facts: facts({ conditionClaims: ["New Balance trainers"] }), checks: baseChecks({ newPrice: { gbp: 100 } }) }).map((s) => s.id)).not.toContain("new_at_low_price");
  });

  it("detects stock imagery and a title/photo model mismatch", () => {
    const stock = signals({ checks: baseChecks({}, { photos: [{ photoIndex: 0, stockPhotoLikely: true, confidence: 0.9, showsSizeLabel: false, showsInsole: false }], notVisible: ["size label", "insole"] }) });
    expect(stock.map((s) => s.id)).toEqual(expect.arrayContaining(["stock_photos", "expected_photos_missing"]));
    const mismatch = signals({
      facts: facts({ title: "Nike Pegasus 40", modelText: "Pegasus 40" }),
      identify: { ...identify, photoModel: { modelName: "Pegasus 41", confidence: 0.9 } },
    });
    expect(mismatch.map((s) => s.id)).toContain("title_photo_mismatch");
  });

  it("only emits the mild missing-photo signal alongside another signal", () => {
    expect(signals({ checks: baseChecks({}, { notVisible: ["size label", "insole"] }) }).map((s) => s.id)).not.toContain("expected_photos_missing");
    expect(signals({ pageText: "WhatsApp me", checks: baseChecks({}, { notVisible: ["size label", "insole"] }) }).map((s) => s.id)).toContain("expected_photos_missing");
  });
});
