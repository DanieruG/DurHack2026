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
  NextMoveSchema,
  PlatformSchema,
  SizeSystemSchema,
  UserNeedsSchema,
  VerdictLabelSchema,
  VerdictSchema,
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
  verdict: VerdictSchema.nullable(),
  nextMoves: z.array(NextMoveSchema),
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
  "leads",
  "verdict",
  "next_moves",
  "reopen",
]);
export type StageName = z.infer<typeof StageNameSchema>;

export const SseEventSchemas = {
  investigation_started: z.object({ caseId: z.string(), revision: z.number().int() }),
  stage_started: z.object({ stage: StageNameSchema, geminiFeatures: z.array(GeminiFeatureSchema).optional() }),
  stage_done: z.object({ stage: StageNameSchema, geminiFeatures: z.array(GeminiFeatureSchema).optional() }),
  capture_warning: z.object({ message: z.string() }),
  check_done: CheckResultSchema,
  lead_started: LeadSchema,
  lead_done: LeadSchema,
  leads_skipped: z.object({ reason: z.string() }),
  verdict: VerdictSchema,
  next_moves: z.array(NextMoveSchema),
  case_reopened: z.object({ caseId: z.string(), revision: z.number().int() }),
  diff: CaseDiffSchema,
  investigation_done: z.object({
    caseId: z.string(),
    revision: z.number().int(),
    durationMs: z.number(),
    geminiCalls: z.number().int(),
  }),
  error: z.object({ stage: z.string().optional(), message: z.string() }),
} as const;

export type SseEventName = keyof typeof SseEventSchemas;
export type SseEventData<E extends SseEventName> = z.infer<(typeof SseEventSchemas)[E]>;

export { CheckNameSchema };
