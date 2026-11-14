import type { CheckResult, CheckStatus, Evidence, EvidenceSourceType, GeminiFeature, UserNeeds } from "@/schemas/domain";
import type { ReviewSnippet } from "@/schemas/seed";
import type { GeminiClient } from "@/gemini/client";
import { z } from "zod";
import { classifySource, sourceToEvidence, type GroundedSource } from "@/gemini/grounding";
import { generateStructured } from "@/gemini/structured";
import { functionTool, type ToolExecutor } from "@/gemini/tools";
import { comfortQuery, type WebResult, type WebSearchClient } from "@/lib/webSearch";
import { containsBanned } from "../verdict/validate";
import { allPriorities } from "../needs";
import type { SizingAdvice } from "./fit";
import { evidenceIds, round2, textContains, unknownCheck, withSearchBudget } from "../util";

export const FALLBACK_CONFIDENCE_CAP = 0.6;
const DEFAULT_PRIORITIES = ["all-day comfort", "durability"];
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

export const COMFORT_SYSTEM = `You summarise web search results about a trainer model for a second-hand buyer.
Each result is numbered [1], [2], ... with its title, site and snippet. Use ONLY what the titles and snippets say.
For each of the buyer's priorities that the results speak to, return one point: {topic: <the priority exactly as given>,
assessment: positive|negative|mixed|unclear, summary: one short plain sentence saying what reviewers say and who says it,
citations}. If the results say whether the model runs small, large or true to size, add a point {topic: "sizing",
sizing: runs_small|runs_large|true_to_size|unclear, summary, citations}. Skip priorities the results don't mention.
citations: one {result: <its number>, quote: <a short phrase copied word for word from that result's snippet>} for each result
that supports the point. Never cite a result for something it doesn't say. Also classify every result as independent_review,
manufacturer, retailer or other: marketing from the brand or a shop is a claim, not an independent review; forum posts and
wearer reviews count as independent.`;

export function comfortPrompt(model: ModelRef, priorities: string[], results: WebResult[]): string {
  const list = results
    .map((r) => `[${r.index}] ${r.title}\n    site: ${r.domain || r.source || "unknown"}\n    ${r.snippet || "(no snippet)"}`)
    .join("\n");
  return `Model: ${model.brand} ${model.name}\nBuyer's priorities: ${priorities.join("; ")}\nSearch results:\n${list}`;
}

export type ComfortParse = {
  priorities: { priority: string; assessment: Assessment; sentence: string; sources: GroundedSource[] }[];
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
    if (!priority) continue;
    const g = groups.get(priority) ?? { assessments: [], sentence: pt.summary.trim(), sources: [] };
    g.assessments.push(pt.assessment ?? "unclear");
    for (const s of cited) if (!g.sources.includes(s)) g.sources.push(s);
    groups.set(priority, g);
  }
  const uniq = (xs: GroundedSource[]) => [...new Set(xs)];
  const decided = sizing.filter((x) => x.advice !== "unclear");
  const pick = decided.length ? decided : sizing;
  const advice = pick.length ? (pick.every((x) => x.advice === pick[0].advice) ? pick[0].advice : "unclear") : null;
  return {
    priorities: [...groups.entries()].map(([priority, g]) => ({ priority, assessment: combine(g.assessments), sentence: g.sentence, sources: g.sources })),
    sizing: advice ? { advice, sentence: pick[0].sentence, sources: uniq(pick.flatMap((x) => x.sources)) } : null,
    sources: [...sources.values()],
  };
}

export type ComfortDetails = {
  reviewSizing: SizingAdvice;
  reviewSizingNote?: string;
  independentSources: number;
  priorities: { priority: string; assessment: Assessment; summary?: string; evidenceIds: string[] }[];
  fallback: boolean;
  /** The web search behind this result (absent on the saved-snippet fallback). */
  search?: { provider: "serpapi"; query: string; fetchedOn: string; results: number; fromCache: boolean };
};

/** Build the CheckResult from the parsed summary. Each cited result is one source evidence item, quoting its snippet. */
export function comfortResult(
  parsed: ComfortParse,
  args: { today: string; features: GeminiFeature[]; search?: ComfortDetails["search"] },
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
    ...(args.search ? { search: args.search } : {}),
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
  const priorities = (allPriorities(args.needs).length ? allPriorities(args.needs) : DEFAULT_PRIORITIES).slice(0, 5);
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

async function searchComfort(args: Parameters<typeof checkComfort>[0], priorities: string[]): Promise<CheckResult> {
  // SEARCH_TIMEOUT_MS caps the web search only; summarising the results is bounded by the stage timeout.
  const query = comfortQuery(args.model.brand, args.model.name);
  const search = await withSearchBudget(args.searchTimeoutMs, () => args.webSearch.search(query));
  if (!search.results.length) throw new ComfortSearchError(`no results for "${query}"`);

  const tools = args.combinedTools ? [functionTool(["convertSize"])] : undefined;
  const { data, calledFunctions } = await generateStructured(args.gemini, ComfortSummarySchema, {
    stage: "comfort",
    tier: "fast",
    system: COMFORT_SYSTEM,
    parts: [{ text: comfortPrompt(args.model, priorities, search.results) }],
    tools,
    executors: args.executors,
    temperature: 0,
    thinking: "LOW",
  });
  const features: GeminiFeature[] = ["structured_output"];
  if (calledFunctions.length) features.push("function_calling");
  const parsed = comfortFromSummary(data, search.results, priorities);
  return comfortResult(parsed, {
    today: args.today,
    features,
    search: { provider: "serpapi", query, fetchedOn: search.fetchedOn, results: search.results.length, fromCache: search.fromCache },
  });
}

function safe(s: string): string {
  return containsBanned(s) ? "Reviewer comment (see source)." : s;
}
