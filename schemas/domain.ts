import { z } from "zod";

// ---------- primitives ----------

export const PlatformSchema = z.enum(["vinted", "facebook", "ebay", "depop", "other"]);
export type Platform = z.infer<typeof PlatformSchema>;

export const SizeSystemSchema = z.enum(["UK", "US", "EU"]);
export type SizeSystem = z.infer<typeof SizeSystemSchema>;

export const CheckNameSchema = z.enum(["identify", "fit", "price", "comfort", "condition"]);
export type CheckName = z.infer<typeof CheckNameSchema>;

export const GeminiFeatureSchema = z.enum([
  "vision",
  "object_detection",
  "search_grounding",
  "function_calling",
  "structured_output",
]);
export type GeminiFeature = z.infer<typeof GeminiFeatureSchema>;

export const Box2dSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type Box2d = z.infer<typeof Box2dSchema>;

export const ConditionGradeSchema = z.enum(["new_with_tags", "like_new", "good", "worn"]);
export type ConditionGrade = z.infer<typeof ConditionGradeSchema>;

// ---------- capture & profile ----------

export const MAX_PAGE_TEXT = 20_000;

/** What the extension (or upload page) sends. Screenshots arrive as multipart files. */
export const CaptureSchema = z.object({
  pageUrl: z.string().url().max(2048).optional(),
  pageText: z.string().max(MAX_PAGE_TEXT).optional(),
  imageUrls: z.array(z.string().url().max(2048)).max(32).optional(),
});
export type Capture = z.infer<typeof CaptureSchema>;

export const ProfileSizeSchema = z.object({
  brand: z.string().min(1).max(60),
  size: z.number().positive().max(60),
  // Optional on input: a missing system is assumed UK by needs.ts and recorded in `assumptions`.
  system: SizeSystemSchema.optional(),
});

export const WearToleranceSchema = z.enum(["none", "light", "moderate", "any"]);
export type WearTolerance = z.infer<typeof WearToleranceSchema>;

/** Saved in the extension, sent with every case. */
export const ProfileSchema = z.object({
  sizes: z.array(ProfileSizeSchema).max(20).default([]),
  priorities: z.array(z.string().min(1).max(80)).max(12).default([]),
  budgetGBP: z.number().positive().max(100_000).optional(),
  wearTolerance: WearToleranceSchema.default("light"),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const UserNeedsSchema = z.object({
  sizes: z.array(z.object({ brand: z.string(), size: z.number(), system: SizeSystemSchema })),
  priorities: z.array(z.string()),
  budgetGBP: z.number().optional(),
  wearTolerance: WearToleranceSchema,
  caseNote: z.string().optional(),
  extraPriorities: z.array(z.string()),
  assumptions: z.array(z.string()),
});
export type UserNeeds = z.infer<typeof UserNeedsSchema>;

// ---------- evidence ----------

export const EvidenceSourceTypeSchema = z.enum([
  "independent_review",
  "manufacturer",
  "retailer",
  "price_sample",
  "other",
]);
export type EvidenceSourceType = z.infer<typeof EvidenceSourceTypeSchema>;

export const EvidenceSchema = z.object({
  id: z.string(),
  kind: z.enum(["quote", "photo_region", "data_point", "source"]),
  label: z.string(),
  quote: z.string().optional(),
  photoIndex: z.number().int().nonnegative().optional(),
  box2d: Box2dSchema.optional(),
  value: z.union([z.string(), z.number()]).optional(),
  url: z.string().optional(),
  /** The source's own site, when `url` is a redirect that doesn't show it (SerpApi web results). */
  domain: z.string().optional(),
  title: z.string().optional(),
  sourceType: EvidenceSourceTypeSchema.optional(),
  observedOn: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

// ---------- pipeline results ----------

export const ListingFactsSchema = z.object({
  title: z.string().optional(),
  brandText: z.string().optional(),
  modelText: z.string().optional(),
  sizeText: z.string().optional(),
  sizeSystem: z.enum(["UK", "US", "EU", "unknown"]).optional(),
  priceGBP: z.number().nonnegative().optional(),
  platform: PlatformSchema,
  conditionClaims: z.array(z.string()),
  photoCount: z.number().int().nonnegative(),
  evidence: z.array(EvidenceSchema),
});
export type ListingFacts = z.infer<typeof ListingFactsSchema>;

/**
 * Tiered identification. Brand and model name are reported even when the model isn't in the catalogue;
 * catalogueModelId is set only for an exact catalogue match. Defaults keep cases stored before the tiers valid.
 */
export const IdentifyResultSchema = z.object({
  /** Recognised brand (catalogue casing when the brand is in the catalogue), or null. */
  brand: z.string().nullable().default(null),
  /** Probability that `brand` is right. */
  brandConfidence: z.number().min(0).max(1).default(0),
  /** Recognised model name without the brand, e.g. "Dropset 3", or null. */
  modelName: z.string().nullable().default(null),
  catalogueModelId: z.string().nullable(),
  inCatalogue: z.boolean().default(false),
  /** Probability that `modelName` (and catalogueModelId, when set) is exactly right. */
  confidence: z.number().min(0).max(1),
  reasons: z.string(),
  evidence: z.array(EvidenceSchema),
  /**
   * Set when the model came only from photos and the Gemini Pro recheck disagreed, declined or timed out: the brand and
   * model family are known, the exact version isn't. `options` are the two candidate versions (B is null when Pro gave none).
   */
  versionUnclear: z
    .object({ family: z.string(), options: z.tuple([z.string(), z.string().nullable()]) })
    .optional(),
});
export type IdentifyResult = z.infer<typeof IdentifyResultSchema>;

export const CheckStatusSchema = z.enum(["pass", "warn", "fail", "unknown"]);
export type CheckStatus = z.infer<typeof CheckStatusSchema>;

export const CheckResultSchema = z.object({
  check: CheckNameSchema,
  status: CheckStatusSchema,
  summary: z.string(),
  evidence: z.array(EvidenceSchema),
  confidence: z.number().min(0).max(1),
  geminiFeatures: z.array(GeminiFeatureSchema),
  details: z.record(z.string(), z.unknown()).optional(),
  /**
   * What the check actually did: its Gemini calls (cachedCalls of them answered from the record/replay cache) and, for
   * comfort (web search) and price (Google Shopping), whether the search was live or served from the cache.
   */
  usage: z
    .object({
      geminiCalls: z.number().int(),
      cachedCalls: z.number().int(),
      search: z.object({ kind: z.enum(["web", "shopping"]), live: z.boolean() }).optional(),
    })
    .optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export const DefectLabelSchema = z.enum([
  "outsole_wear",
  "heel_wear",
  "upper_creasing",
  "stitching_damage",
  "discolouration",
  "tear_or_hole",
  "sole_separation",
  "dirt_or_staining",
]);
export type DefectLabel = z.infer<typeof DefectLabelSchema>;

export const SeveritySchema = z.enum(["minor", "moderate", "major"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const ConditionFindingSchema = z.object({
  label: DefectLabelSchema,
  photoIndex: z.number().int().nonnegative(),
  box2d: Box2dSchema,
  severity: SeveritySchema,
  confidence: z.number().min(0).max(1), // < 0.6 is presented as "possible"
  note: z.string(),
  evidenceId: z.string(),
});
export type ConditionFinding = z.infer<typeof ConditionFindingSchema>;

export const VerdictLabelSchema = z.enum([
  "hidden_gem",
  "worth_a_look",
  "proceed_with_caution",
  "overpriced",
  "wrong_fit",
  "not_enough_evidence",
]);
export type VerdictLabel = z.infer<typeof VerdictLabelSchema>;

export const VerdictSchema = z.object({
  label: VerdictLabelSchema,
  ruleId: z.string(),
  headline: z.string(),
  explanation: z.string(),
  citedEvidenceIds: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  badge: z.enum(["out_sleuthed"]).nullable(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const LeadTypeSchema = z.enum([
  "deeper_price_comparison",
  "recheck_identification",
  "recheck_condition_photo",
  "flag_for_seller",
]);
export type LeadType = z.infer<typeof LeadTypeSchema>;

export const LeadSchema = z.object({
  id: z.string(),
  type: LeadTypeSchema,
  reason: z.string(),
  status: z.enum(["pending", "done", "skipped", "failed"]),
  outcome: z.string().optional(),
  /** Which check the lead is about (used by flag_for_seller to target a seller question). */
  relatesTo: CheckNameSchema.optional(),
});
export type Lead = z.infer<typeof LeadSchema>;

/**
 * Whether follow-up leads were considered for a revision, and if they were skipped, why (one plain line).
 * Not considered: every check was clear (or leads are turned off), so the case file hides the section.
 */
export const LeadsReportSchema = z.object({
  considered: z.boolean(),
  skipped: z.string().optional(),
});
export type LeadsReport = z.infer<typeof LeadsReportSchema>;

export const NextMoveSchema = z.object({
  id: z.string(),
  kind: z.enum(["ask_seller", "before_you_pay"]),
  text: z.string(),
  relatesTo: z.array(CheckNameSchema),
});
export type NextMove = z.infer<typeof NextMoveSchema>;

export const CaseDiffSchema = z.object({
  fromRevision: z.number().int(),
  toRevision: z.number().int(),
  checks: z.array(
    z.object({ check: CheckNameSchema, before: z.string(), after: z.string(), reason: z.string() }),
  ),
  verdict: z.object({ before: VerdictLabelSchema, after: VerdictLabelSchema }),
});
export type CaseDiff = z.infer<typeof CaseDiffSchema>;

export const CaseSummarySchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  title: z.string().optional(),
  priceGBP: z.number().optional(),
  platform: PlatformSchema,
  verdictLabel: VerdictLabelSchema.optional(),
  thumbnailUrl: z.string().optional(),
  /** The listing the case was opened from ("View listing"). */
  pageUrl: z.string().nullable().default(null),
  status: z.enum(["open", "investigating", "closed", "error"]).default("closed"),
  createdAt: z.string().optional(),
  updatedAt: z.string(),
});
export type CaseSummary = z.infer<typeof CaseSummarySchema>;

export const CaseStatusSchema = z.enum(["open", "investigating", "closed", "error"]);
export type CaseStatus = z.infer<typeof CaseStatusSchema>;

// ---------- check details (section 7.6) ----------

export const SampleStatsSchema = z.object({
  n: z.number().int(),
  excluded: z.number().int(),
  median: z.number(),
  p10: z.number(),
  p25: z.number(),
  p75: z.number(),
  p90: z.number(),
  collectedOn: z.object({ from: z.string(), to: z.string() }),
  /** Sampling rule ids behind the kept samples (see data/sampling-rules.md). */
  ruleIds: z.array(z.string()),
  /** True when any sample is placeholder data (ruleId starting "SYNTHETIC"); surfaced in evidence labels. */
  placeholder: z.boolean(),
});
export type SampleStats = z.infer<typeof SampleStatsSchema>;

export const PricePositionSchema = z.enum([
  "below",
  "typical",
  "above",
  "suspiciously_low",
  "at_or_above_new",
]);
export type PricePosition = z.infer<typeof PricePositionSchema>;

export const FitMatchSchema = z.enum(["exact", "close", "mismatch", "estimated"]);
export type FitMatch = z.infer<typeof FitMatchSchema>;
