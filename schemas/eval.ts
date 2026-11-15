import { z } from "zod";

/**
 * eval/summary.json: the evaluation's figures, machine-readable. Shared by eval/run.ts (writes it), GET
 * /api/eval/summary (serves the public part) and the side panel ("How accurate is Sleuth?"). Never holds listing text,
 * photos, URLs or anything about a seller or user: case ids and counts only.
 */

/** A count out of a sample: "17 of 20 (85%)". percent is a whole number rounded against us (null when d is 0). */
export const FractionSchema = z.object({
  kind: z.literal("fraction"),
  label: z.string(),
  n: z.number().int().nonnegative(),
  d: z.number().int().nonnegative(),
  percent: z.number().nullable(),
  /** Whether a higher figure is better (rounded down) or worse (rounded up). */
  higherIsBetter: z.boolean(),
});
export type Fraction = z.infer<typeof FractionSchema>;

/** A duration or count over cases: the median and the slowest (largest), with how many cases it covers. */
export const SpreadSchema = z.object({
  kind: z.literal("spread"),
  label: z.string(),
  unit: z.enum(["seconds", "calls"]),
  /** Number of cases measured. */
  n: z.number().int().nonnegative(),
  median: z.number().nullable(),
  max: z.number().nullable(),
  mean: z.number().nullable(),
});
export type Spread = z.infer<typeof SpreadSchema>;

export const FigureSchema = z.discriminatedUnion("kind", [FractionSchema, SpreadSchema]);
export type Figure = z.infer<typeof FigureSchema>;

export const HEADLINE_IDS = ["modelIdentification", "defectDetection", "falseAlarms", "fitAccuracy", "timePerCase"] as const;
export type HeadlineId = (typeof HEADLINE_IDS)[number];

export const EvalSummarySchema = z.object({
  runAt: z.string(),
  pipelineVersion: z.string(),
  models: z.object({ fast: z.string().nullable(), strong: z.string().nullable() }),
  cacheMode: z.string(),
  /** Listings run (each one labelled by hand, some labels possibly still missing). */
  cases: z.number().int().nonnegative(),
  /** Two boxes match when their intersection over union is at least this. */
  overlapThreshold: z.number(),
  sections: z.array(z.object({ title: z.string(), figures: z.array(z.object({ id: z.string(), figure: FigureSchema })) })),
  headline: z.object(Object.fromEntries(HEADLINE_IDS.map((id) => [id, FigureSchema])) as Record<HeadlineId, typeof FigureSchema>),
  /** Which cases ran with the extension's structured fields (and which groups), and which had page text only. */
  structuredCapture: z
    .object({ with: z.array(z.object({ caseId: z.string(), groups: z.array(z.string()) })), without: z.array(z.string()) })
    .optional(),
  /** What went wrong where: case ids and short descriptions (model names, sizes, colours; no listing text). */
  failures: z.array(z.object({ caseId: z.string(), metric: z.string(), detail: z.string() })),
});
export type EvalSummary = z.infer<typeof EvalSummarySchema>;

/** What GET /api/eval/summary serves: the figures and when they were measured, no failure list. */
export const PublicEvalSummarySchema = EvalSummarySchema.omit({ failures: true });
export type PublicEvalSummary = z.infer<typeof PublicEvalSummarySchema>;

// ---------- wording, shared by the report, the slide and the panel ----------

/** "17 of 20 (85%)", or "not measured yet (0 labelled)". */
export function fractionText(f: Fraction): string {
  if (f.d === 0) return "not measured yet (0 labelled)";
  return `${f.n} of ${f.d} (${f.percent}%)`;
}

const seconds = (s: number) => `${s.toFixed(1)} s`;

/** "median 41.3 s, slowest 58.0 s (12 cases)". */
export function spreadText(s: Spread): string {
  if (!s.n || s.median === null) return "not measured yet (0 cases)";
  const fmt = s.unit === "seconds" ? seconds : (x: number) => `${x}`;
  const mean = s.unit === "calls" && s.mean !== null ? `, mean ${s.mean.toFixed(1)}` : "";
  return `median ${fmt(s.median)}${mean}, ${s.unit === "seconds" ? "slowest" : "most"} ${fmt(s.max!)} (${s.n} case${s.n === 1 ? "" : "s"})`;
}

export function figureText(f: Figure): string {
  return f.kind === "fraction" ? fractionText(f) : spreadText(f);
}

/** "Tested on 12 real listings we labelled by hand. Small sample; results will vary." */
export function honestLine(cases: number): string {
  return `Tested on ${cases} real listing${cases === 1 ? "" : "s"} we labelled by hand. Small sample; results will vary.`;
}
