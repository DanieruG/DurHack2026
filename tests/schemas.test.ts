import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as S from "@/schemas";
import { loadSeedFiles } from "@/lib/seedData";

const evidence = { id: "ev_cond_1", kind: "photo_region", label: "Moderate outsole wear (photo 2)", photoIndex: 1, box2d: [100, 200, 300, 400], quote: "worn heel" };
const check = { check: "condition", status: "warn", summary: "Moderate outsole wear.", evidence: [evidence], confidence: 0.7, geminiFeatures: ["vision", "object_detection"], details: { findings: [] } };
const verdict = { label: "proceed_with_caution", ruleId: "R5", headline: "Loose ends.", explanation: "One. Two.", citedEvidenceIds: ["ev_cond_1"], confidence: 0.7, badge: null };
const needs = { sizes: [{ brand: "Nike", size: 9, system: "UK" }], priorities: ["all-day comfort"], wearTolerance: "light", extraPriorities: [], assumptions: [] };
const facts = { title: "Pegasus", priceGBP: 38, platform: "vinted", conditionClaims: ["Good"], photoCount: 2, evidence: [evidence] };

const fixtures: [string, z.ZodType, unknown][] = [
  ["Platform", S.PlatformSchema, "vinted"],
  ["Capture", S.CaptureSchema, { pageUrl: "https://www.vinted.co.uk/items/1", pageText: "text", imageUrls: ["https://img.example.com/a.jpg"] }],
  ["Profile", S.ProfileSchema, { sizes: [{ brand: "Nike", size: 9, system: "UK" }], priorities: ["wide fit"], budgetGBP: 60, wearTolerance: "light" }],
  ["UserNeeds", S.UserNeedsSchema, { ...needs, caseNote: "for the gym" }],
  ["Evidence", S.EvidenceSchema, evidence],
  ["Evidence(source)", S.EvidenceSchema, { id: "ev_comf_1", kind: "source", label: "Independent review: runrepeat.com", url: "https://x", title: "runrepeat.com", sourceType: "independent_review", observedOn: "2026-11-14" }],
  ["ListingFacts", S.ListingFactsSchema, facts],
  ["IdentifyResult", S.IdentifyResultSchema, { catalogueModelId: null, confidence: 0.3, reasons: "unsure", evidence: [] }],
  ["CheckResult", S.CheckResultSchema, check],
  ["ConditionFinding", S.ConditionFindingSchema, { label: "heel_wear", photoIndex: 0, box2d: [1, 2, 3, 4], severity: "minor", confidence: 0.5, note: "n", evidenceId: "ev_cond_1" }],
  ["Verdict", S.VerdictSchema, verdict],
  ["Lead", S.LeadSchema, { id: "lead_1", type: "flag_for_seller", reason: "r", status: "done", outcome: "o", relatesTo: "comfort" }],
  ["NextMove", S.NextMoveSchema, { id: "nm_ask_1", kind: "ask_seller", text: "Could you share a photo?", relatesTo: ["condition"] }],
  ["CaseDiff", S.CaseDiffSchema, { fromRevision: 1, toRevision: 2, checks: [{ check: "fit", before: "unknown", after: "pass", reason: "r" }], verdict: { before: "proceed_with_caution", after: "worth_a_look" } }],
  ["CaseSummary", S.CaseSummarySchema, { id: "c1", revision: 1, platform: "ebay", updatedAt: "2026-11-14T12:00:00.000Z" }],
  ["SampleStats", S.SampleStatsSchema, { n: 5, excluded: 0, median: 1, p10: 1, p25: 1, p75: 1, p90: 1, collectedOn: { from: "2026-11-01", to: "2026-11-02" }, ruleIds: ["R-newest-N"], placeholder: false }],
  ["FeedItem", S.FeedItemSchema, { caseId: "c1", modelName: "Nike Pegasus 40", priceGBP: 38, platform: "vinted", verdictLabel: "hidden_gem", oneLineEvidence: "e", priceSource: "s", checkedAt: "2026-11-14T12:00:00.000Z" }],
  ["CaseDetail", S.CaseDetailSchema, { id: "c1", revision: 1, status: "closed", platform: "vinted", pageUrl: null, listingFacts: facts, needs, identify: null, checks: [check], leads: [], verdict, nextMoves: [], evidenceIndex: { ev_cond_1: evidence }, imageUrls: [], history: [{ revision: 1, verdictLabel: "proceed_with_caution", at: "2026-11-14T12:00:00.000Z" }] }],
  ["ShareRequest", S.ShareRequestSchema, { optIn: true }],
];

describe("schemas round-trip fixtures", () => {
  it.each(fixtures)("%s", (_, schema, value) => {
    const parsed = schema.parse(value);
    expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });
  it("every SSE event schema accepts a fixture", () => {
    const samples: Record<keyof typeof S.SseEventSchemas, unknown> = {
      investigation_started: { caseId: "c1", revision: 1 },
      stage_started: { stage: "identify", geminiFeatures: ["vision"] },
      stage_done: { stage: "identify" },
      capture_warning: { message: "Only 1 photo could be loaded" },
      check_done: check,
      new_offers: {
        offers: [{ retailer: "Decathlon UK", title: "Nike Pegasus 40", priceGBP: 79.99, url: "https://www.decathlon.co.uk/p/1", differenceGBP: 37.99, isLowest: true }],
        checkedOn: "2026-11-14",
        enoughForComparison: false,
      },
      lead_started: { id: "lead_1", type: "deeper_price_comparison", reason: "r", status: "pending" },
      lead_done: { id: "lead_1", type: "deeper_price_comparison", reason: "r", status: "done", outcome: "o" },
      leads_skipped: { reason: "Skipped: the review search was unavailable." },
      verdict,
      next_moves: [],
      case_reopened: { caseId: "c1", revision: 2 },
      diff: { fromRevision: 1, toRevision: 2, checks: [], verdict: { before: "worth_a_look", after: "hidden_gem" } },
      investigation_done: { caseId: "c1", revision: 1, durationMs: 10, geminiCalls: 4 },
      error: { stage: "price", message: "m" },
    };
    for (const [name, schema] of Object.entries(S.SseEventSchemas)) expect(schema.safeParse(samples[name as keyof typeof samples]).success, name).toBe(true);
  });
  it("rejects bad input", () => {
    expect(S.ProfileSchema.safeParse({ sizes: [{ brand: "Nike", size: 9, system: "JP" }] }).success).toBe(false);
    expect(S.CaptureSchema.safeParse({ pageText: "x".repeat(20_001) }).success).toBe(false);
    expect(S.VerdictSchema.safeParse({ ...verdict, label: "scam" }).success).toBe(false);
  });
  it("the committed /data seed files are valid", () => {
    const seed = loadSeedFiles();
    expect(seed.catalogue.length).toBeGreaterThanOrEqual(15);
    expect(seed.catalogue.length).toBeLessThanOrEqual(20);
  });
});
