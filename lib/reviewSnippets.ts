import { classifySource } from "@/gemini/grounding";
import { hashObject } from "./hash";
import type { WebResult } from "./webSearch";
import { ReviewSnippetSchema, type ReviewSnippet } from "@/schemas/seed";
import type { EvidenceSourceType } from "@/schemas/domain";

/**
 * Saved review snippets (the comfort check's fallback when the live search fails), built from the same SerpApi search
 * the live check runs. Topics are tagged in code from the snippet's own words, in the format comfortFromSnippets reads:
 * "positive:<topic>", "negative:<topic>", "sizing:runs_small|runs_large|true_to_size".
 */

const NEG = /\b(not|isn'?t|wasn'?t|no longer|never|hardly)\s+(very\s+|that\s+|particularly\s+)?/i;

function has(text: string, re: RegExp): boolean {
  const m = re.exec(text);
  if (!m) return false;
  const before = text.slice(Math.max(0, m.index - 24), m.index);
  return !NEG.test(before);
}

/** Rating widgets ("between Uncomfortable and Very Comfortable", "Runs small … Runs big") are scale labels, not opinions. */
const SCALE_LABELS = /\bbetween [a-z ]{3,30} and [a-z ]{3,30}\b|\buncomfortable\s*very comfortable\b|\bruns small\s*(true to size\s*)?runs (big|large)\b/gi;

export function reviewTopics(text: string): string[] {
  const t = text.toLowerCase().replace(SCALE_LABELS, " ");
  const topics = new Set<string>();
  if (/\buncomfortable\b|\b(stiff|painful|blisters?|hurts?|harsh)\b/.test(t)) topics.add("negative:comfort");
  else if (has(t, /\b(comfortable|comfy|comfort|plush|cushion(ed|ing|y)?|soft)\b/)) topics.add("positive:comfort");
  if (/\b(narrow|tight|snug)\b/.test(t) && !/\bwide (fit|toe|version)\b/.test(t)) topics.add("negative:wide fit");
  else if (/\b(wide|roomy|spacious)\b/.test(t)) topics.add("positive:wide fit");
  if (/\b(fell apart|wore (out|through)|falling apart|sole (separat|came off)|durability (issues|problems)|not durable)\b/.test(t)) topics.add("negative:durability");
  else if (has(t, /\b(durable|long[- ]lasting|hard[- ]wearing|durability)\b/)) topics.add("positive:durability");
  if (/\b(all[- ]day|long days|standing|walking)\b/.test(t) && topics.has("positive:comfort")) topics.add("positive:all-day comfort");
  if (/\bruns? (a bit |half a size |slightly )?(small|short)\b|\bsize up\b|\bgo (half a size |a size )?up\b/.test(t)) topics.add("sizing:runs_small");
  else if (/\bruns? (a bit |half a size |slightly )?(large|big|long)\b|\bsize down\b|\bgo (half a size |a size )?down\b/.test(t)) topics.add("sizing:runs_large");
  else if (/\btrue to size\b|\btts\b|\bfits true\b/.test(t)) topics.add("sizing:true_to_size");
  return [...topics];
}

/**
 * A resolved redirect is trusted only when it lands on the site SerpApi displayed for the result (when one was shown):
 * Google's goto links occasionally resolve to an unrelated page.
 */
export function resolvedMatches(r: Pick<WebResult, "domain">, url: string): boolean {
  if (!r.domain) return true;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    return host === r.domain || host.endsWith(`.${r.domain}`) || r.domain.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

/**
 * One ReviewSnippet per usable result (it needs a snippet and a real site). `resolved` maps redirect links to the real
 * URL; `hints` are Gemini's source types by link, used (as in the live check) only for domains the heuristics don't know.
 */
export function snippetsFromResults(
  modelId: string,
  results: WebResult[],
  resolved: Record<string, string> = {},
  hints: Record<string, EvidenceSourceType> = {},
): ReviewSnippet[] {
  const out: ReviewSnippet[] = [];
  for (const r of results) {
    const real = resolved[r.link];
    const url = real && resolvedMatches(r, real) ? real : r.link;
    let host = "";
    try {
      host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    // A Google redirect that couldn't be resolved would make every source look like google.com: skip it.
    if (!r.snippet || /(^|\.)google\.[a-z.]+$/.test(host)) continue;
    const parsed = ReviewSnippetSchema.safeParse({
      modelId,
      text: r.snippet,
      url,
      title: r.title,
      sourceType: classifySource(r.domain || host, hints[r.link]),
      topics: reviewTopics(`${r.title}. ${r.snippet}`),
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Deterministic row ids (content + position), shared by `npm run seed` and scripts/seed-reviews.ts. */
export function reviewRows(reviews: ReviewSnippet[]) {
  return reviews.map((r, i) => ({ id: `rs_${hashObject(r).slice(0, 20)}_${i}`, ...r }));
}

/** Distinct independent-review sites among a model's snippets. */
export function independentSites(snippets: ReviewSnippet[]): number {
  return new Set(snippets.filter((s) => s.sourceType === "independent_review").map((s) => new URL(s.url).hostname.replace(/^www\./, ""))).size;
}
