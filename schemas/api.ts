import { z } from "zod";
import {
  CaseDiffSchema,
  CaseStatusSchema,
  CaseSummarySchema,
  CheckNameSchema,
  CheckResultSchema,
  EvidenceSchema,
  GeminiFeatureSchema,
  IdentifyResultSchema,
  LeadSchema,
  LeadsReportSchema,
  ListingFactsSchema,
  NewOffersSchema,
  NextMoveSchema,
  ObservedAlternativesSchema,
  ObservedComparisonSchema,
  PlatformSchema,
  SizeSystemSchema,
  UserNeedsSchema,
  VerdictLabelSchema,
  VerdictSchema,
  WarningSignalSchema,
} from "./domain";
import { FeedItemSchema } from "./seed";

// ---------- requests ----------

export const ShareRequestSchema = z.object({ optIn: z.boolean() });

export const SummariesQuerySchema = z.object({
  ids: z
    .string()
    .min(1)
    .transform((s) => [...new Set(s.split(",").map((x) => x.trim()).filter(Boolean))])
    .pipe(z.array(z.string().regex(/^[a-z0-9]{8,40}$/i)).min(1).max(50)),
});

export const FeedQuerySchema = z.object({
  brand: z.string().max(60).optional(),
  size: z.coerce.number().positive().max(60).optional(),
  system: SizeSystemSchema.optional(),
});

// ---------- responses ----------

export const CaseCreatedSchema = z.object({ caseId: z.string() });
export const ReopenAcceptedSchema = z.object({ caseId: z.string(), revision: z.number().int() });
export const ShareResponseSchema = z.object({ shareOptIn: z.boolean() });
export const ErrorResponseSchema = z.object({ error: z.string(), details: z.unknown().optional() });

export const CaseDetailSchema = z.object({
  id: z.string(),
  revision: z.number().int(),
  status: CaseStatusSchema,
  platform: PlatformSchema,
  pageUrl: z.string().nullable(),
  listingFacts: ListingFactsSchema.nullable(),
  needs: UserNeedsSchema,
  identify: IdentifyResultSchema.nullable(),
  checks: z.array(CheckResultSchema),
  leads: z.array(LeadSchema),
  /** For the revision shown: were leads considered, and if skipped, why. */
  leadsReport: LeadsReportSchema.default({ considered: false }),
  /** Totals for the revision shown (from investigation_done); null for cases run before they were recorded. */
  run: z.object({ durationMs: z.number(), geminiCalls: z.number().int(), cachedCalls: z.number().int().optional() }).nullable().default(null),
  verdict: VerdictSchema.nullable(),
  nextMoves: z.array(NextMoveSchema),
  /** New-price offers from the shown revision's price check (its details.newOffers); null when none were looked up. */
  newOffers: NewOffersSchema.nullable().default(null),
  /** The shown revision's comparison with the user's search survey (price details.observedComparison); null without a survey. */
  observedComparison: ObservedComparisonSchema.nullable().default(null),
  /** Cheaper listings from the user's survey ("Worth looking at"); surveyUsed false when no survey came with the case. */
  observedAlternatives: ObservedAlternativesSchema.default({ surveyUsed: false, platform: null, surveyedOn: null, alternatives: [] }),
  warningSignals: z.array(WarningSignalSchema).default([]),
  evidenceIndex: z.record(z.string(), EvidenceSchema),
  imageUrls: z.array(z.string()),
  history: z.array(
    z.object({ revision: z.number().int(), verdictLabel: VerdictLabelSchema, at: z.string() }),
  ),
});
export type CaseDetail = z.infer<typeof CaseDetailSchema>;

export const CaseSummariesResponseSchema = z.array(CaseSummarySchema);
export const FeedResponseSchema = z.array(FeedItemSchema);

// ---------- SSE events (section 8) ----------

export const StageNameSchema = z.enum([
  "intake",
  "extract",
  "needs",
  "identify",
  "fit",
  "price",
  "comfort",
  "condition",
  "colour",
  "version_check",
  "lens",
  "leads",
  "verdict",
  "next_moves",
  "reopen",
]);
export type StageName = z.infer<typeof StageNameSchema>;

/** One candidate offered to the buyer: its name, how sure Sleuth is, and a short summary of the evidence for it. */
export const IdentityOptionSchema = z.object({
  brand: z.string().nullable(),
  model: z.string().nullable(),
  version: z.string().nullable(),
  colourway: z.string().nullable(),
  /** "Nike Air Max 95 Essential". */
  label: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()),
});
export type IdentityOption = z.infer<typeof IdentityOptionSchema>;

/** The buyer's answer to "Is this the right item?" (POST /api/cases/:id/confirm-identity). */
export const IdentityChoiceSchema = z.discriminatedUnion("choice", [
  z.object({ choice: z.literal("best_guess") }),
  z.object({ choice: z.literal("alternative"), index: z.number().int().min(0).max(1) }),
  z.object({
    choice: z.literal("custom"),
    brand: z.string().trim().min(1).max(60),
    model: z.string().trim().min(1).max(80),
    version: z.string().trim().max(60).optional(),
    colourway: z.string().trim().max(60).optional(),
  }),
  z.object({ choice: z.literal("skip") }),
]);
export type IdentityChoice = z.infer<typeof IdentityChoiceSchema>;

export const SseEventSchemas = {
  investigation_started: z.object({ caseId: z.string(), revision: z.number().int() }),
  stage_started: z.object({ stage: StageNameSchema, geminiFeatures: z.array(GeminiFeatureSchema).optional() }),
  /** geminiFeatures here are what the stage actually used; geminiCalls/cachedCalls count its Gemini calls (cache hits included). */
  stage_done: z.object({
    stage: StageNameSchema,
    geminiFeatures: z.array(GeminiFeatureSchema).optional(),
    geminiCalls: z.number().int().optional(),
    cachedCalls: z.number().int().optional(),
  }),
  capture_warning: z.object({ message: z.string() }),
  /**
   * Identification is only a possible or best guess: the investigation pauses before every model-dependent step until the
   * buyer answers POST /api/cases/:id/confirm-identity. Condition and fit keep streaming meanwhile.
   */
  identity_check_needed: z.object({
    level: z.enum(["possible", "best_guess"]),
    /** The identify line, e.g. "Possibly Nike Air Max 95 Essential or OG". */
    headline: z.string(),
    bestGuess: IdentityOptionSchema,
    alternatives: z.array(IdentityOptionSchema).max(2),
    lensMatches: z.array(z.object({ title: z.string(), source: z.string().nullable(), url: z.string().optional() })),
    /** Checks held back until the buyer answers. */
    waiting: z.array(CheckNameSchema),
  }),
  check_done: CheckResultSchema,
  /** Sent as soon as the price check's Shopping lookup completes (live or cached), before the check itself finishes. */
  new_offers: NewOffersSchema,
  /** Sent as soon as the price check has evaluated the user's survey: its cheaper alternatives. */
  observed_alternatives: ObservedAlternativesSchema,
  lead_started: LeadSchema,
  lead_done: LeadSchema,
  leads_skipped: z.object({ reason: z.string() }),
  verdict: VerdictSchema,
  next_moves: z.array(NextMoveSchema),
  warning_signals: z.array(WarningSignalSchema),
  case_reopened: z.object({ caseId: z.string(), revision: z.number().int() }),
  diff: CaseDiffSchema,
  investigation_done: z.object({
    caseId: z.string(),
    revision: z.number().int(),
    durationMs: z.number(),
    geminiCalls: z.number().int(),
    /** How many of geminiCalls were answered from the record/replay cache. */
    cachedCalls: z.number().int().optional(),
  }),
  error: z.object({ stage: z.string().optional(), message: z.string() }),
} as const;

export type SseEventName = keyof typeof SseEventSchemas;
export type SseEventData<E extends SseEventName> = z.infer<(typeof SseEventSchemas)[E]>;

export { CheckNameSchema };
