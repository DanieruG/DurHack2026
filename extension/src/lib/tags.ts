import type { CheckResult, GeminiFeature } from "@/schemas/domain";

/**
 * Small tags for what each step actually did. Built from facts the server reports, never from what a step planned:
 * no Gemini tag without a Gemini call, "function calling" only when Gemini called a tool, and "cached" instead of a
 * search or Gemini tag when the answer came from the cache without a live call.
 */

const WORDS: Partial<Record<GeminiFeature, string>> = {
  object_detection: "object detection",
  function_calling: "function calling",
  search_grounding: "search grounding",
};

/** ["vision", "object_detection"] -> "Gemini vision · object detection"; ["function_calling"] -> "Gemini · function calling". */
export function geminiTag(features: GeminiFeature[]): string | null {
  if (!features.length) return null;
  const rest = features.filter((f) => f !== "vision" && f !== "structured_output").map((f) => WORDS[f] ?? f.replace(/_/g, " "));
  return [`Gemini${features.includes("vision") ? " vision" : ""}`, ...rest].join(" · ");
}

const uniq = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))];

/** A pipeline step (stage_done): its actual features and call counts. */
export function stepTags(s: { geminiFeatures?: GeminiFeature[]; geminiCalls?: number; cachedCalls?: number }): string[] {
  if (s.geminiCalls === 0) return [];
  const allCached = !!s.geminiCalls && s.cachedCalls === s.geminiCalls;
  return uniq([geminiTag(s.geminiFeatures ?? []), allCached ? "cached" : null]);
}

/** An exhibit (check result). */
export function checkTags(c: Pick<CheckResult, "geminiFeatures" | "usage">): string[] {
  const u = c.usage;
  const allCached = !!u && u.geminiCalls > 0 && u.cachedCalls === u.geminiCalls;
  const search = u?.search ? (u.search.live ? (u.search.kind === "web" ? "Web search" : "Google Shopping") : "cached") : null;
  return uniq([geminiTag(c.geminiFeatures), allCached ? "cached" : null, search]);
}

/** "7 Gemini calls · 11.4s" (cache hits noted). */
export function runTotals(r: { durationMs: number; geminiCalls: number; cachedCalls?: number }): string {
  const calls = `${r.geminiCalls} Gemini call${r.geminiCalls === 1 ? "" : "s"}${r.cachedCalls ? ` (${r.cachedCalls} cached)` : ""}`;
  return `${calls} · ${(r.durationMs / 1000).toFixed(1)}s`;
}
