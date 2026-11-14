import type { StageName } from "@/schemas/api";
import type { CheckName, CheckResult, Evidence, GeminiFeature } from "@/schemas/domain";
import { withDeadline, withStageContext } from "@/gemini/client";
import type { Emit } from "./events";

export class StageTimeoutError extends Error {
  constructor(public readonly stage: string, ms: number) {
    super(`${stage} took longer than ${Math.round(ms / 1000)}s`);
    this.name = "StageTimeoutError";
  }
}

/** A Google Search grounded call exceeded SEARCH_TIMEOUT_MS; the check falls back to saved data. */
export class SearchTimeoutError extends Error {
  constructor(ms: number) {
    super(`search took longer than ${Math.round(ms / 1000)}s`);
    this.name = "SearchTimeoutError";
  }
}

/** Cap a search-grounded step at `ms` (SEARCH_TIMEOUT_MS). No cap when ms is undefined. */
export function withSearchBudget<T>(ms: number | undefined, fn: () => Promise<T>): Promise<T> {
  return ms ? withDeadline(ms, () => new SearchTimeoutError(ms), fn) : fn();
}

/**
 * Run one pipeline stage: emits stage_started / stage_done, applies STAGE_TIMEOUT_MS
 * (aborting in-flight Gemini calls), and tags Gemini calls with the stage name for the call log.
 */
export async function runStage<T>(
  stage: StageName,
  opts: { emit: Emit; timeoutMs: number; geminiFeatures?: GeminiFeature[] },
  fn: () => Promise<T>,
): Promise<T> {
  opts.emit("stage_started", { stage, ...(opts.geminiFeatures ? { geminiFeatures: opts.geminiFeatures } : {}) });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new StageTimeoutError(stage, opts.timeoutMs));
      }, opts.timeoutMs);
    });
    return await Promise.race([withStageContext(stage, controller.signal, fn), timeout]);
  } finally {
    clearTimeout(timer);
    opts.emit("stage_done", { stage, ...(opts.geminiFeatures ? { geminiFeatures: opts.geminiFeatures } : {}) });
  }
}

/** Stable, readable evidence ids within a case: ev_fit_1, ev_cond_2, ... */
export function evidenceIds(prefix: string) {
  let n = 0;
  return () => `ev_${prefix}_${++n}`;
}

export function unknownCheck(check: CheckName, summary: string, extra: Partial<CheckResult> = {}): CheckResult {
  return { check, status: "unknown", summary, evidence: [], confidence: 0, geminiFeatures: [], ...extra };
}

/** Plain-language reason for a failed/timed-out stage (never leaks stack traces). */
export function plainError(check: CheckName, err: unknown): string {
  const what: Record<CheckName, string> = {
    identify: "identify the model",
    fit: "check the fit",
    price: "check the price",
    comfort: "check reviews for comfort",
    condition: "check the photos for condition",
  };
  if (err instanceof StageTimeoutError) return `I ran out of time trying to ${what[check]}, so this is unknown.`;
  return `Something went wrong while trying to ${what[check]}, so this is unknown.`;
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0));
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function today(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function gbp(n: number): string {
  return `£${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

/** Whitespace/punctuation-insensitive containment, for verifying model "quotes" against the page text. */
export function textContains(haystack: string, needle: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s ]+/g, " ").replace(/[^\p{L}\p{N} £$€.,/]/gu, "").trim();
  const n = norm(needle);
  return n.length > 0 && norm(haystack).includes(n);
}

export function indexEvidence(...lists: (Evidence[] | undefined)[]): Record<string, Evidence> {
  const out: Record<string, Evidence> = {};
  for (const list of lists) for (const e of list ?? []) out[e.id] = e;
  return out;
}
