import type { CheckResult, CheckStatus, Evidence, GeminiFeature, UserNeeds } from "@/schemas/domain";
import type { ReviewSnippet } from "@/schemas/seed";
import type { GeminiClient } from "@/gemini/client";
import {
  groundingSources,
  parseSourceTypeHints,
  sourcesForLine,
  sourceToEvidence,
  type GroundedSource,
} from "@/gemini/grounding";
import { functionTool, runToolLoop, type ToolExecutor } from "@/gemini/tools";
import { containsBanned } from "../verdict/validate";
import { allPriorities } from "../needs";
import type { SizingAdvice } from "./fit";
import { evidenceIds, round2, unknownCheck, withSearchBudget } from "../util";

export const FALLBACK_CONFIDENCE_CAP = 0.6;
const DEFAULT_PRIORITIES = ["all-day comfort", "durability"];
type Assessment = "positive" | "negative" | "mixed" | "unclear";

/** The model to research: brand and name (catalogue or not). */
export type ModelRef = { brand: string; name: string };

export function comfortPrompt(model: ModelRef, priorities: string[]): string {
  return (
    `Research what independent reviewers and wearers say about the ${model.brand} ${model.name} trainers ` +
    `for a buyer who cares about: ${priorities.join("; ")}. Also check sizing advice (do they run small, large or true to size?).\n` +
    `Answer ONLY with these lines, one sentence each, based on what you found in search results:\n` +
    priorities.map((p) => `PRIORITY | ${p} | <positive|negative|mixed|unclear> | <what reviewers say>`).join("\n") +
    `\nSIZING | <runs_small|runs_large|true_to_size|unclear> | <what reviewers say about sizing>\n` +
    `SOURCETYPES | <domain>=<independent_review|manufacturer|retailer|other>; ... (one entry per source you used)\n` +
    `Treat manufacturer and retailer marketing as claims, not reviews.`
  );
}

export type ComfortParse = {
  priorities: { priority: string; assessment: Assessment; sentence: string; sources: GroundedSource[] }[];
  sizing: { advice: SizingAdvice; sentence: string; sources: GroundedSource[] } | null;
  sources: GroundedSource[];
};

export function parseComfort(text: string, meta: Parameters<typeof groundingSources>[0]): ComfortParse {
  const sources = groundingSources(meta, parseSourceTypeHints(text));
  const priorities: ComfortParse["priorities"] = [];
  let sizing: ComfortParse["sizing"] = null;
  for (const line of text.split("\n")) {
    const p = /^\s*PRIORITY\s*\|\s*(.+?)\s*\|\s*(positive|negative|mixed|unclear)\s*\|\s*(.+)$/i.exec(line);
    if (p) {
      const sentence = p[3].trim();
      priorities.push({ priority: p[1].trim(), assessment: p[2].toLowerCase() as Assessment, sentence, sources: sourcesForLine(sources, sentence) });
      continue;
    }
    const s = /^\s*SIZING\s*\|\s*(runs_small|runs_large|true_to_size|unclear)\s*\|\s*(.+)$/i.exec(line);
    if (s) {
      const sentence = s[2].trim();
      sizing = { advice: s[1].toLowerCase() as SizingAdvice, sentence, sources: sourcesForLine(sources, sentence) };
    }
  }
  return { priorities, sizing, sources };
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
  const contents = [{ role: "user" as const, parts: [{ text: comfortPrompt(args.model, priorities) }] }];
  try {
    return await withSearchBudget(args.searchTimeoutMs, () => searchComfort(args, contents));
  } catch (err) {
    if ((err as Error)?.name === "StageTimeoutError") throw err;
    return comfortFromSnippets(args.snippets, args.needs, args.today);
  }
}

async function searchComfort(
  args: Parameters<typeof checkComfort>[0],
  contents: { role: "user"; parts: { text: string }[] }[],
): Promise<CheckResult> {
  let text: string;
  let meta;
  const features: GeminiFeature[] = ["search_grounding"];
  if (args.combinedTools) {
    const res = await runToolLoop(args.gemini, {
      stage: "comfort",
      tier: "fast",
      contents,
      config: { temperature: 0.2, tools: [{ googleSearch: {} }, functionTool(["convertSize"])], toolConfig: { includeServerSideToolInvocations: true } },
      executors: args.executors,
    });
    text = res.response.text;
    meta = res.response.groundingMetadata;
    if (res.calledFunctions.length) features.push("function_calling");
  } else {
    const res = await args.gemini.generate({ stage: "comfort", tier: "fast", contents, config: { temperature: 0.2, tools: [{ googleSearch: {} }] } });
    text = res.text;
    meta = res.groundingMetadata;
  }
  const parsed = parseComfort(text, meta);
  if (parsed.sources.length === 0) throw new Error("no grounding sources");
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
