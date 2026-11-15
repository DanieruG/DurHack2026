import type { CheckResult, CheckStatus, Evidence, EvidenceSourceType, GeminiFeature, UserNeeds } from "@/schemas/domain";
import type { ReviewSnippet } from "@/schemas/seed";
import type { GeminiClient } from "@/gemini/client";
import { z } from "zod";
import { classifySource, sourceToEvidence, type GroundedSource } from "@/gemini/grounding";
import { generateStructured } from "@/gemini/structured";
import { functionTool, type ToolExecutor } from "@/gemini/tools";
import { comfortQuery, problemsQuery, type WebResult, type WebSearchClient, type WebSearchResponse } from "@/lib/webSearch";
import { containsBanned } from "../verdict/validate";
import { allPriorities } from "../needs";
import type { SizingAdvice } from "./fit";
import { evidenceIds, round2, textContains, unknownCheck, withSearchBudget } from "../util";

export const FALLBACK_CONFIDENCE_CAP = 0.6;
/** Results from both searches handed to Gemini (the review search first, then the problems search). */
export const MAX_COMFORT_RESULTS = 10;
const MAX_GENERAL_POINTS = 6;
type Assessment = "positive" | "negative" | "mixed" | "unclear";

/** The model to research: brand and name (catalogue or not). */
export type ModelRef = { brand: string; name: string };

/**
 * Comfort from a SerpApi web search ("{brand} {model} review comfort", UK, top 6 organic results).
 * Gemini gets the results as numbered text, with no search tool, and summarises comfort against the buyer's
 * priorities, citing results by index and quoting the snippet. Each cited result becomes source evidence.
 */

const ASSESSMENTS = ["positive", "negative", "mixed", "unclear"] as const;
const SIZINGS = ["runs_small", "runs_large", "true_to_size", "unclear"] as const;
const SOURCE_TYPES = ["independent_review", "manufacturer", "retailer", "other"] as const;

export const ComfortSummarySchema = z.object({
  points: z
    .array(
      z.object({
        /** One of the buyer's priorities (as given), or "sizing". */
        topic: z.string(),
        assessment: z.enum(ASSESSMENTS).nullish(),
        sizing: z.enum(SIZINGS).nullish(),
        /** One plain sentence saying what the cited results say, and who says it. */
        summary: z.string(),
        citations: z.array(z.object({ result: z.number().int(), quote: z.string().default("") })).default([]),
      }),
    )
    .default([]),
  sourceTypes: z.array(z.object({ result: z.number().int(), type: z.enum(SOURCE_TYPES) })).default([]),
});
export type ComfortSummary = z.infer<typeof ComfortSummarySchema>;

export const COMFORT_SYSTEM = `You summarise web search results about a trainer model for a second-hand buyer, fairly.
Each result is numbered [1], [2], ... with its title, site and snippet. Use ONLY what the titles and snippets say.
The results come from a search for reviews AND a search for problems and complaints. Report BOTH what reviewers like and what
they dislike. Never leave out a criticism because it is not one of the buyer's priorities, and don't favour praise.
For each of the buyer's priorities that the results speak to, return one point: {topic: <the priority exactly as given>,
assessment: positive|negative|mixed|unclear, summary: one short plain sentence saying what reviewers say and who says it,
citations}. Then add a point for every other recurring strength or weakness the results mention about comfort, fit,
cushioning, durability or wear, with topic a short label such as "heel slip", "narrow toe box" or "cushioning" and assessment
positive or negative (at most 6 of these; include every negative one a result raises). If the buyer gave no priorities, return only
these general points. If the results say whether the model runs small, large or true to size, add a point {topic: "sizing",
sizing: runs_small|runs_large|true_to_size|unclear, summary, citations}. Skip priorities the results don't mention.
citations: one {result: <its number>, quote: <a short phrase copied word for word from that result's snippet>} for each result
that supports the point. Never cite a result for something it doesn't say. Also classify every result as independent_review,
manufacturer, retailer or other: marketing from the brand or a shop is a claim, not an independent review; forum posts and
wearer reviews count as independent.`;

export function comfortPrompt(model: ModelRef, priorities: string[], results: WebResult[]): string {
  const list = results
    .map((r) => `[${r.index}] ${r.title}\n    site: ${r.domain || r.source || "unknown"}\n    ${r.snippet || "(no snippet)"}`)
    .join("\n");
  const wanted = priorities.length ? priorities.join("; ") : "none stated: give a balanced overview of what reviewers like and dislike";
  return `Model: ${model.brand} ${model.name}\nBuyer's priorities: ${wanted}\nSearch results:\n${list}`;
}

export type ComfortParse = {
  priorities: { priority: string; assessment: Assessment; sentence: string; sources: GroundedSource[] }[];
  /** Strengths and weaknesses reviewers raise that are not one of the buyer's priorities (all of them when there are no priorities). */
  general: { topic: string; assessment: Assessment; sentence: string; sources: GroundedSource[] }[];
  sizing: { advice: SizingAdvice; sentence: string; sources: GroundedSource[] } | null;
  sources: GroundedSource[];
};

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * A search result as a source. `segments` holds the verbatim snippet phrases Gemini quoted from it. With no known site
 * (domain ""), only the model's hint can classify it, and never as better than "other" unless the hint says so.
 */
export function resultSource(r: WebResult, hint?: EvidenceSourceType): GroundedSource {
  const sourceType = r.domain ? classifySource(r.domain, hint) : hint && hint !== "price_sample" ? hint : "other";
  // Domain stands in for "who": results with no site get a per-result key so they never merge.
  return { chunkIndex: r.index, url: r.link, title: r.title, domain: r.domain || `result-${r.index}`, sourceType, segments: [] };
}

function combine(assessments: Assessment[]): Assessment {
  const known = assessments.filter((a) => a !== "unclear");
  if (!known.length) return "unclear";
  if (known.every((a) => a === known[0])) return known[0];
  return "mixed";
}

/**
 * The quote shown for a cited result: Gemini's phrase if it really is in the snippet (or title), else the snippet itself.
 * Quotes are never invented text.
 */
export function verifiedQuote(r: WebResult, quote: string): string | null {
  const q = quote.trim().replace(/^["“”']+|["“”']+$/g, "").trim();
  if (q.length >= 8 && (textContains(r.snippet, q) || textContains(r.title, q))) return q;
  return r.snippet || null;
}

/**
 * One entry per priority (and one for sizing), each carrying only the results it cites. Citations of results that
 * don't exist, and topics that aren't one of the priorities, are dropped.
 */
export function comfortFromSummary(summary: ComfortSummary, results: WebResult[], priorities: string[]): ComfortParse {
  const hints = new Map(summary.sourceTypes.map((t) => [t.result, t.type]));
  const sources = new Map(results.map((r) => [r.index, resultSource(r, hints.get(r.index))]));
  const byIndex = new Map(results.map((r) => [r.index, r]));
  const lower = new Map(priorities.map((p) => [p.toLowerCase(), p]));

  const cite = (citations: ComfortSummary["points"][number]["citations"]) => {
    const out: GroundedSource[] = [];
    for (const c of citations) {
      const r = byIndex.get(c.result);
      const src = sources.get(c.result);
      if (!r || !src) continue;
      const quote = verifiedQuote(r, c.quote);
      if (quote && !src.segments.includes(quote)) src.segments.push(quote);
      if (!out.includes(src)) out.push(src);
    }
    return out;
  };

  const groups = new Map<string, { assessments: Assessment[]; sentence: string; sources: GroundedSource[] }>();
  const generalGroups = new Map<string, { assessments: Assessment[]; sentence: string; sources: GroundedSource[] }>();
  const sizing: { advice: SizingAdvice; sentence: string; sources: GroundedSource[] }[] = [];
  for (const pt of summary.points) {
    const cited = cite(pt.citations);
    if (!cited.length) continue;
    const topic = pt.topic.trim().toLowerCase();
    if (topic === "sizing") {
      if (pt.sizing) sizing.push({ advice: pt.sizing, sentence: pt.summary.trim(), sources: cited });
      continue;
    }
    const priority = lower.get(topic);
    // A topic that isn't one of the priorities is still something reviewers said: kept as a general point, so a criticism
    // outside the buyer's list (or any criticism when they gave no list) is never dropped.
    const label = priority ?? topic.slice(0, 40);
    if (!label) continue;
    const target = priority ? groups : generalGroups;
    if (!priority && !generalGroups.has(label) && generalGroups.size >= MAX_GENERAL_POINTS) continue;
    const g = target.get(label) ?? { assessments: [], sentence: pt.summary.trim(), sources: [] };
    g.assessments.push(pt.assessment ?? "unclear");
    for (const s of cited) if (!g.sources.includes(s)) g.sources.push(s);
    target.set(label, g);
  }
  const uniq = (xs: GroundedSource[]) => [...new Set(xs)];
  const decided = sizing.filter((x) => x.advice !== "unclear");
  const pick = decided.length ? decided : sizing;
  const advice = pick.length ? (pick.every((x) => x.advice === pick[0].advice) ? pick[0].advice : "unclear") : null;
  return {
    priorities: [...groups.entries()].map(([priority, g]) => ({ priority, assessment: combine(g.assessments), sentence: g.sentence, sources: g.sources })),
    general: [...generalGroups.entries()].map(([topic, g]) => ({ topic, assessment: combine(g.assessments), sentence: g.sentence, sources: g.sources })),
    sizing: advice ? { advice, sentence: pick[0].sentence, sources: uniq(pick.flatMap((x) => x.sources)) } : null,
    sources: [...sources.values()],
  };
}

export type ComfortDetails = {
  reviewSizing: SizingAdvice;
  reviewSizingNote?: string;
  independentSources: number;
  priorities: { priority: string; assessment: Assessment; summary?: string; evidenceIds: string[] }[];
  /** What reviewers say beyond the buyer's priorities, good and bad. */
  general: { topic: string; assessment: Assessment; summary?: string; evidenceIds: string[] }[];
  fallback: boolean;
  /** The web search behind this result (absent on the saved-snippet fallback). */
  search?: { provider: "serpapi"; query: string; /** Every query run: reviews, then problems. */ queries?: string[]; fetchedOn: string; results: number; fromCache: boolean };
};

/** Build the CheckResult from the parsed summary. Each cited result is one source evidence item, quoting its snippet. */
export function comfortResult(
  parsed: ComfortParse,
  args: {
    today: string;
    features: GeminiFeature[];
    search?: ComfortDetails["search"];
    /** The buyer gave priorities (the wording of the unknown and "don't support" summaries differs). */
    hadPriorities?: boolean;
    /** The search for problems and complaints ran and returned results, so "no complaints" means something. */
    negativesSearched?: boolean;
  },
): CheckResult {
  const nextId = evidenceIds("comf");
  const evidence: Evidence[] = [];
  const evBySource = new Map<number, string>();
  const evFor = (src: GroundedSource, fallbackQuote: string) => {
    const existing = evBySource.get(src.chunkIndex);
    if (existing) return existing;
    const e = sourceToEvidence(src, nextId(), args.today, safe(src.segments[0] ?? fallbackQuote));
    evidence.push(e);
    evBySource.set(src.chunkIndex, e.id);
    return e.id;
  };

  const priorityDetails = parsed.priorities.map((p) => ({
    priority: p.priority,
    assessment: p.assessment,
    summary: safe(p.sentence),
    evidenceIds: p.sources.map((s) => evFor(s, p.sentence)),
  }));
  const generalDetails = parsed.general.map((g) => ({
    topic: g.topic,
    assessment: g.assessment,
    summary: safe(g.sentence),
    evidenceIds: g.sources.map((s) => evFor(s, g.sentence)),
  }));
  const sizingIds = parsed.sizing?.sources.map((s) => evFor(s, parsed.sizing!.sentence)) ?? [];

  const supporting = [...parsed.priorities.flatMap((p) => p.sources), ...parsed.general.flatMap((g) => g.sources), ...(parsed.sizing?.sources ?? [])];
  const independent = new Set(supporting.filter((s) => s.sourceType === "independent_review").map((s) => s.domain)).size;

  const sizingAdvice: SizingAdvice = parsed.sizing && sizingIds.length ? parsed.sizing.advice : "unclear";
  const details: ComfortDetails = {
    reviewSizing: sizingAdvice,
    reviewSizingNote: sizingAdvice !== "unclear" ? safe(parsed.sizing!.sentence) : undefined,
    independentSources: independent,
    priorities: priorityDetails,
    general: generalDetails,
    fallback: false,
    ...(args.search ? { search: args.search } : {}),
  };

  if (supporting.length === 0) {
    return unknownCheck("comfort", parsed.priorities.length || args.hadPriorities ? "I couldn't find reviews that speak to your priorities for this model." : "I couldn't find reviews that say much about comfort for this model.", {
      geminiFeatures: args.features,
      details,
    });
  }

  // Praise and criticism both count, whether or not it is one of the buyer's priorities. A point is "supported" only by
  // non-manufacturer sources, and praise only by an independent review.
  type Point = { label: string; assessment: Assessment; sources: GroundedSource[] };
  const points: Point[] = [...parsed.priorities.map((p) => ({ label: p.priority, assessment: p.assessment, sources: p.sources })), ...parsed.general.map((g) => ({ label: g.topic, assessment: g.assessment, sources: g.sources }))];
  const negatives = points.filter((p) => p.assessment === "negative" && p.sources.some((s) => s.sourceType !== "manufacturer"));
  const supportedPositives = points.filter((p) => p.assessment === "positive" && p.sources.some((s) => s.sourceType === "independent_review"));
  const quoted = (ps: Point[]) => ps.map((p) => `"${p.label}"`).join(" and ");

  let status: CheckStatus;
  let summary: string;
  if (independent < 2) {
    status = "warn";
    summary = `Only ${independent} independent review${independent === 1 ? "" : "s"} found, so comfort for your needs isn't well established.`;
    if (negatives.length) summary += ` Reviewers do raise concerns about ${quoted(negatives)}.`;
  } else if (negatives.length) {
    status = "warn";
    summary = `Reviews raise concerns for ${quoted(negatives)}.`;
    if (supportedPositives.length) summary += ` Reviewers also like ${quoted(supportedPositives)}.`;
  } else if (supportedPositives.length === 0) {
    status = "warn";
    summary = parsed.priorities.length || args.hadPriorities ? "Reviews don't clearly support your priorities for this model." : "Reviews don't say clearly whether these are comfortable.";
  } else {
    status = "pass";
    summary = `${independent} independent reviews are positive on ${quoted(supportedPositives)}.`;
    if (args.negativesSearched) summary += " A search for complaints found none.";
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

/** Fallback when the web search fails: seeded ReviewSnippet rows (same Evidence shape, confidence capped at 0.6). */
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
    // With no priorities every concern counts; with some, only the ones that touch them.
    .filter((t) => !priorities.length || priorities.some((p) => p.includes(t) || t.includes(p.split(" ")[0])));
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
      general: [],
      fallback: true,
    } satisfies ComfortDetails,
  };
}

/** The web search failed (error, timeout, no key, or no results): comfort uses the saved review snippets. */
export class ComfortSearchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComfortSearchError";
  }
}

export async function checkComfort(args: {
  gemini: GeminiClient;
  webSearch: WebSearchClient;
  model: ModelRef;
  needs: UserNeeds;
  today: string;
  /** GEMINI_COMBINED_TOOLS: offer convertSize to the summarising call (function calling, same output shape). */
  combinedTools: boolean;
  executors: Partial<Record<string, ToolExecutor>>;
  snippets: ReviewSnippet[];
  /** SEARCH_TIMEOUT_MS: past this, the saved review snippets are used instead. */
  searchTimeoutMs?: number;
}): Promise<CheckResult> {
  // No priorities is fine: the summary is then a balanced overview of what reviewers like and dislike.
  const priorities = allPriorities(args.needs).slice(0, 5);
  try {
    return await searchComfort(args, priorities);
  } catch (err) {
    if ((err as Error)?.name === "StageTimeoutError") throw err;
    if (!process.env.VITEST) console.warn(`[comfort] web search failed, using saved reviews: ${(err as Error)?.name}: ${(err as Error)?.message}`);
    const fallback = comfortFromSnippets(args.snippets, args.needs, args.today);
    // Unknown only because the search failed (no saved reviews to fall back on): leads can't fix that.
    return fallback.status === "unknown" ? { ...fallback, details: { ...fallback.details, searchFailed: true } } : fallback;
  }
}

/** Both searches' results as one list: reviews first, then problems, one per link, numbered from 1. */
export function mergeResults(lists: WebResult[][], max = MAX_COMFORT_RESULTS): WebResult[] {
  const seen = new Set<string>();
  const out: WebResult[] = [];
  // Interleave, so the problems search isn't squeezed out by the cap.
  for (let i = 0; out.length < max && lists.some((l) => i < l.length); i++) {
    for (const l of lists) {
      const r = l[i];
      if (r && !seen.has(r.link) && out.length < max) {
        seen.add(r.link);
        out.push({ ...r, index: out.length + 1 });
      }
    }
  }
  return out;
}

async function searchComfort(args: Parameters<typeof checkComfort>[0], priorities: string[]): Promise<CheckResult> {
  // SEARCH_TIMEOUT_MS caps each web search only; summarising the results is bounded by the stage timeout.
  // Two searches, so the picture is balanced: one for reviews, one for problems and complaints.
  const query = comfortQuery(args.model.brand, args.model.name);
  const issuesQuery = problemsQuery(args.model.brand, args.model.name);
  const [reviews, issues] = await Promise.allSettled([
    withSearchBudget(args.searchTimeoutMs, () => args.webSearch.search(query)),
    withSearchBudget(args.searchTimeoutMs, () => args.webSearch.search(issuesQuery)),
  ]);
  const ok = [reviews, issues].filter((r): r is PromiseFulfilledResult<WebSearchResponse> => r.status === "fulfilled");
  if (!ok.length) throw (reviews as PromiseRejectedResult).reason;
  const results = mergeResults([reviews, issues].map((r) => (r.status === "fulfilled" ? r.value.results : [])));
  if (!results.length) throw new ComfortSearchError(`no results for "${query}"`);
  const negativesSearched = issues.status === "fulfilled" && issues.value.results.length > 0;
  const first = ok[0].value;

  const tools = args.combinedTools ? [functionTool(["convertSize"])] : undefined;
  const { data, calledFunctions } = await generateStructured(args.gemini, ComfortSummarySchema, {
    stage: "comfort",
    tier: "fast",
    system: COMFORT_SYSTEM,
    parts: [{ text: comfortPrompt(args.model, priorities, results) }],
    tools,
    executors: args.executors,
    temperature: 0,
    thinking: "LOW",
  });
  const features: GeminiFeature[] = ["structured_output"];
  if (calledFunctions.length) features.push("function_calling");
  const parsed = comfortFromSummary(data, results, priorities);
  return comfortResult(parsed, {
    today: args.today,
    features,
    hadPriorities: priorities.length > 0,
    negativesSearched,
    search: { provider: "serpapi", query, queries: [query, issuesQuery], fetchedOn: first.fetchedOn, results: results.length, fromCache: ok.every((r) => r.value.fromCache) },
  });
}

function safe(s: string): string {
  return containsBanned(s) ? "Reviewer comment (see source)." : s;
}
