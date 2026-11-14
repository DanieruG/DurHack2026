import type { CheckResult, CheckStatus, Evidence, GeminiFeature, UserNeeds } from "@/schemas/domain";
import type { ReviewSnippet } from "@/schemas/seed";
import type { GeminiClient } from "@/gemini/client";
import { z } from "zod";
import { classifySource, sourceToEvidence, type GroundedSource } from "@/gemini/grounding";
import { groundedSearch, resolveSegment, segmentList, type Segment } from "@/gemini/groundedSearch";
import { generateStructured } from "@/gemini/structured";
import type { ToolExecutor } from "@/gemini/tools";
import { containsBanned } from "../verdict/validate";
import { allPriorities } from "../needs";
import type { SizingAdvice } from "./fit";
import { evidenceIds, round2, unknownCheck, withSearchBudget } from "../util";

export const FALLBACK_CONFIDENCE_CAP = 0.6;
const DEFAULT_PRIORITIES = ["all-day comfort", "durability"];
type Assessment = "positive" | "negative" | "mixed" | "unclear";

/** The model to research: brand and name (catalogue or not). */
export type ModelRef = { brand: string; name: string };

/**
 * Step 1 (grounded): plain prose. A rigid "PRIORITY | ... |" line format made Gemini 3 return no grounding chunks or
 * supports (it searched, but attached no sources); plain sentences keep them.
 */
export function comfortPrompt(model: ModelRef, priorities: string[]): string {
  return (
    `What do independent reviewers and wearers say about the ${model.brand} ${model.name} trainers on ` +
    `${priorities.join(", ")}, and do they run small, large or true to size? Search for reviews and answer in short plain ` +
    `sentences, one point per sentence, saying who said it. Treat manufacturer and retailer marketing as claims, not reviews.`
  );
}

export type ComfortParse = {
  priorities: { priority: string; assessment: Assessment; sentence: string; sources: GroundedSource[] }[];
  sizing: { advice: SizingAdvice; sentence: string; sources: GroundedSource[] } | null;
  sources: GroundedSource[];
};

const ASSESSMENTS = ["positive", "negative", "mixed", "unclear"] as const;
const SIZINGS = ["runs_small", "runs_large", "true_to_size", "unclear"] as const;

export const ComfortPointsSchema = z.object({
  points: z
    .array(
      z.object({
        segment: z.string(),
        /** One of the buyer's priorities (as given), or "sizing". */
        topic: z.string(),
        assessment: z.enum(ASSESSMENTS).nullish(),
        sizing: z.enum(SIZINGS).nullish(),
      }),
    )
    .default([]),
  sourceTypes: z.array(z.object({ domain: z.string(), type: z.enum(["independent_review", "manufacturer", "retailer", "other"]) })).default([]),
});
export type ComfortPoints = z.infer<typeof ComfortPointsSchema>;

const COMFORT_PARSE_SYSTEM = `You turn review-search sentences into data. Each sentence has an id (S1, S2, ...) and its source domains.
"segment" is always the sentence id only, e.g. "S3", never the sentence text.
For every sentence about one of the buyer's priorities, return {segment, topic: <the priority exactly as given>, assessment:
positive|negative|mixed|unclear}. For every sentence about sizing, return {segment, topic: "sizing", sizing: runs_small|runs_large|
true_to_size|unclear}. Skip sentences about anything else. Also classify each source domain as independent_review, manufacturer,
retailer or other (marketing from the brand or a shop is not an independent review). Use only what the sentences say.`;

/** Step 2 (no tools): structure the supported sentences. */
export async function structureComfort(gemini: GeminiClient, segments: Segment[], priorities: string[]): Promise<ComfortPoints> {
  const { data } = await generateStructured(gemini, ComfortPointsSchema, {
    stage: "comfort_parse",
    tier: "fast",
    system: COMFORT_PARSE_SYSTEM,
    parts: [{ text: `Buyer's priorities: ${priorities.join("; ")}\nSentences:\n${segmentList(segments)}` }],
    temperature: 0,
    thinking: "LOW",
  });
  return data;
}

function combine(assessments: Assessment[]): Assessment {
  const known = assessments.filter((a) => a !== "unclear");
  if (!known.length) return "unclear";
  if (known.every((a) => a === known[0])) return known[0];
  return "mixed";
}

/**
 * One entry per priority (and one for sizing), each carrying only the sources of its own sentences. Points that
 * reference no real sentence, or a topic that isn't one of the priorities, are dropped.
 */
export function comfortFromPoints(points: ComfortPoints, segments: Segment[], priorities: string[]): ComfortParse {
  const hints = Object.fromEntries(points.sourceTypes.map((t) => [t.domain.toLowerCase().replace(/^www\./, ""), t.type]));
  for (const seg of segments) for (const src of seg.sources) src.sourceType = classifySource(src.domain, hints[src.domain]);
  const lower = new Map(priorities.map((p) => [p.toLowerCase(), p]));
  const groups = new Map<string, { assessments: Assessment[]; segs: Segment[] }>();
  const sizing: { advice: SizingAdvice; seg: Segment }[] = [];
  for (const pt of points.points) {
    const seg = resolveSegment(segments, pt.segment);
    if (!seg) continue;
    const topic = pt.topic.trim().toLowerCase();
    if (topic === "sizing") {
      if (pt.sizing) sizing.push({ advice: pt.sizing, seg });
      continue;
    }
    const priority = lower.get(topic);
    if (!priority) continue;
    const g = groups.get(priority) ?? { assessments: [], segs: [] };
    g.assessments.push(pt.assessment ?? "unclear");
    if (!g.segs.includes(seg)) g.segs.push(seg);
    groups.set(priority, g);
  }
  const uniq = (xs: GroundedSource[]) => [...new Set(xs)];
  const parsedPriorities = [...groups.entries()].map(([priority, g]) => ({
    priority,
    assessment: combine(g.assessments),
    sentence: g.segs[0].text,
    sources: uniq(g.segs.flatMap((s) => s.sources)),
  }));
  const decided = sizing.filter((x) => x.advice !== "unclear");
  const pick = decided.length ? decided : sizing;
  const advice = pick.length ? (pick.every((x) => x.advice === pick[0].advice) ? pick[0].advice : "unclear") : null;
  return {
    priorities: parsedPriorities,
    sizing: advice ? { advice, sentence: pick[0].seg.text, sources: uniq(pick.flatMap((x) => x.seg.sources)) } : null,
    sources: uniq(segments.flatMap((s) => s.sources)),
  };
}

export type ComfortDetails = {
  reviewSizing: SizingAdvice;
  reviewSizingNote?: string;
  independentSources: number;
  priorities: { priority: string; assessment: Assessment; evidenceIds: string[] }[];
  fallback: boolean;
};

/** Build the CheckResult from parsed grounded lines (shared by the separate and combined-tools paths). */
export function comfortResult(parsed: ComfortParse, args: { today: string; features: GeminiFeature[] }): CheckResult {
  const nextId = evidenceIds("comf");
  const evidence: Evidence[] = [];
  const evByChunk = new Map<number, string>();
  const evFor = (src: GroundedSource, quote: string) => {
    const existing = evByChunk.get(src.chunkIndex);
    if (existing) return existing;
    const e = sourceToEvidence(src, nextId(), args.today, safe(quote));
    evidence.push(e);
    evByChunk.set(src.chunkIndex, e.id);
    return e.id;
  };

  const priorityDetails = parsed.priorities.map((p) => ({
    priority: p.priority,
    assessment: p.assessment,
    evidenceIds: p.sources.map((s) => evFor(s, p.sentence)),
  }));
  const sizingIds = parsed.sizing?.sources.map((s) => evFor(s, parsed.sizing!.sentence)) ?? [];

  const supporting = [...parsed.priorities.flatMap((p) => p.sources), ...(parsed.sizing?.sources ?? [])];
  const independent = new Set(supporting.filter((s) => s.sourceType === "independent_review").map((s) => s.domain)).size;

  const sizingAdvice: SizingAdvice = parsed.sizing && sizingIds.length ? parsed.sizing.advice : "unclear";
  const details: ComfortDetails = {
    reviewSizing: sizingAdvice,
    reviewSizingNote: sizingAdvice !== "unclear" ? safe(parsed.sizing!.sentence) : undefined,
    independentSources: independent,
    priorities: priorityDetails,
    fallback: false,
  };

  if (supporting.length === 0) {
    return unknownCheck("comfort", "I couldn't find reviews that speak to your priorities for this model.", {
      geminiFeatures: args.features,
      details,
    });
  }

  // A priority counts as "supported" only by non-manufacturer sources.
  const indepSupport = (p: ComfortParse["priorities"][number]) => p.sources.some((s) => s.sourceType === "independent_review");
  const negatives = parsed.priorities.filter((p) => p.assessment === "negative" && p.sources.some((s) => s.sourceType !== "manufacturer"));
  const supportedPositives = parsed.priorities.filter((p) => p.assessment === "positive" && indepSupport(p));

  let status: CheckStatus;
  let summary: string;
  if (independent < 2) {
    status = "warn";
    summary = `Only ${independent} independent review${independent === 1 ? "" : "s"} found, so comfort for your needs isn't well established.`;
  } else if (negatives.length) {
    status = "warn";
    summary = `Reviews raise concerns for ${negatives.map((n) => `"${n.priority}"`).join(" and ")}.`;
  } else if (supportedPositives.length === 0) {
    status = "warn";
    summary = "Reviews don't clearly support your priorities for this model.";
  } else {
    status = "pass";
    summary = `${independent} independent reviews are positive on ${supportedPositives.map((p) => `"${p.priority}"`).join(" and ")}.`;
  }

  return {
    check: "comfort",
    status,
    summary,
    evidence,
    confidence: Math.min(0.85, round2(0.45 + 0.1 * independent)),
    geminiFeatures: args.features,
    details,
  };
}

/** Fallback when grounding fails: seeded ReviewSnippet rows (same Evidence shape, confidence capped at 0.6). */
export function comfortFromSnippets(snippets: ReviewSnippet[], needs: UserNeeds, today: string): CheckResult {
  const nextId = evidenceIds("comf");
  if (snippets.length === 0) {
    return unknownCheck("comfort", "I couldn't check reviews for this model right now.");
  }
  const evidence: Evidence[] = snippets.slice(0, 6).map((s) => ({
    id: nextId(),
    kind: "source",
    label: `${s.sourceType === "independent_review" ? "Independent review" : "Source"}: ${s.title}`,
    url: s.url,
    title: s.title,
    quote: s.text,
    sourceType: s.sourceType,
    observedOn: today,
  }));
  const independent = new Set(snippets.filter((s) => s.sourceType === "independent_review").map((s) => hostOf(s.url))).size;
  const topics = snippets.flatMap((s) => s.topics.map((t) => t.toLowerCase()));
  const priorities = allPriorities(needs).map((p) => p.toLowerCase());
  const concerns = topics
    .filter((t) => t.startsWith("negative:"))
    .map((t) => t.slice("negative:".length))
    .filter((t) => priorities.some((p) => p.includes(t) || t.includes(p.split(" ")[0])));
  const sizing: SizingAdvice = topics.includes("sizing:runs_small") ? "runs_small" : topics.includes("sizing:runs_large") ? "runs_large" : topics.includes("sizing:true_to_size") ? "true_to_size" : "unclear";

  let status: CheckStatus = "pass";
  let summary = `Saved reviews (${independent} independent) are broadly positive for this model.`;
  if (independent < 2) {
    status = "warn";
    summary = `Only ${independent} independent review${independent === 1 ? "" : "s"} available, so comfort isn't well established.`;
  } else if (concerns.length) {
    status = "warn";
    summary = `Saved reviews raise concerns about ${[...new Set(concerns)].join(", ")}.`;
  }
  return {
    check: "comfort",
    status,
    summary,
    evidence,
    confidence: Math.min(FALLBACK_CONFIDENCE_CAP, round2(0.4 + 0.1 * independent)),
    geminiFeatures: [],
    details: {
      reviewSizing: sizing,
      reviewSizingNote: sizing !== "unclear" ? `Saved reviews say these ${sizing.replace("_", " ").replace("runs", "run")}.` : undefined,
      independentSources: independent,
      priorities: [],
      fallback: true,
    } satisfies ComfortDetails,
  };
}

export async function checkComfort(args: {
  gemini: GeminiClient;
  model: ModelRef;
  needs: UserNeeds;
  today: string;
  combinedTools: boolean;
  executors: Partial<Record<string, ToolExecutor>>;
  snippets: ReviewSnippet[];
  /** SEARCH_TIMEOUT_MS: past this, the saved review snippets are used instead. */
  searchTimeoutMs?: number;
}): Promise<CheckResult> {
  const priorities = (allPriorities(args.needs).length ? allPriorities(args.needs) : DEFAULT_PRIORITIES).slice(0, 5);
  try {
    return await withSearchBudget(args.searchTimeoutMs, () => searchComfort(args, priorities));
  } catch (err) {
    if ((err as Error)?.name === "StageTimeoutError") throw err;
    const fallback = comfortFromSnippets(args.snippets, args.needs, args.today);
    // Unknown only because the search failed (no saved reviews to fall back on): leads can't fix that.
    return fallback.status === "unknown" ? { ...fallback, details: { ...fallback.details, searchFailed: true } } : fallback;
  }
}

async function searchComfort(args: Parameters<typeof checkComfort>[0], priorities: string[]): Promise<CheckResult> {
  const answer = await groundedSearch(args.gemini, {
    stage: "comfort",
    prompt: comfortPrompt(args.model, priorities),
    temperature: 0.2,
    combinedTools: args.combinedTools,
    functions: ["convertSize"],
    executors: args.executors,
  });
  const features: GeminiFeature[] = ["search_grounding"];
  if (answer.calledFunctions.length) features.push("function_calling");
  const parsed = comfortFromPoints(await structureComfort(args.gemini, answer.segments, priorities), answer.segments, priorities);
  return comfortResult(parsed, { today: args.today, features });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function safe(s: string): string {
  return containsBanned(s) ? "Reviewer comment (see source)." : s;
}
