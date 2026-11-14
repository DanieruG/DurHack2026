import type { ConditionGrade, SampleStats } from "@/schemas/domain";
import type { PriceSample } from "@/schemas/seed";

export const MIN_SAMPLES = 5;

/**
 * Outlier rule (documented in data/sampling-rules.md and spec 7.6):
 * exclude samples above 3x or below 1/3 of the median of ALL samples, then compute stats.
 * Samples are never removed by hand.
 */
export function excludeOutliers(prices: number[]): { kept: number[]; excluded: number } {
  if (prices.length === 0) return { kept: [], excluded: 0 };
  const m = median(prices);
  const kept = prices.filter((p) => p <= 3 * m && p >= m / 3);
  return { kept, excluded: prices.length - kept.length };
}

/** Linear-interpolation percentile (same method as numpy's default). */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return round2(sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo));
}

export function median(values: number[]): number {
  return percentile([...values].sort((a, b) => a - b), 50);
}

/**
 * Stats over sampled listings for a model, optionally restricted to a condition grade.
 * Returns null when fewer than MIN_SAMPLES remain after the outlier rule (Source A unavailable).
 */
export function sampleStats(
  samples: PriceSample[],
  modelId: string,
  condition?: ConditionGrade,
): SampleStats | null {
  const rows = samples.filter((s) => s.modelId === modelId && (!condition || s.condition === condition));
  const { kept, excluded } = excludeOutliers(rows.map((r) => r.priceGBP));
  if (kept.length < MIN_SAMPLES) return null;
  const sorted = [...kept].sort((a, b) => a - b);
  const keptRows = rows.filter((r) => kept.includes(r.priceGBP));
  const dates = keptRows.map((r) => r.collectedOn.slice(0, 10)).sort();
  return {
    n: kept.length,
    excluded,
    median: percentile(sorted, 50),
    p10: percentile(sorted, 10),
    p25: percentile(sorted, 25),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    collectedOn: { from: dates[0], to: dates[dates.length - 1] },
    ruleIds: [...new Set(keptRows.map((r) => r.ruleId))].sort(),
    placeholder: keptRows.some((r) => r.ruleId.startsWith("SYNTHETIC")),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "10 Nov" or "3–10 Nov" or "28 Oct – 10 Nov". */
export function formatDateRange(from: string, to: string): string {
  const f = new Date(from + "T00:00:00Z");
  const t = new Date(to + "T00:00:00Z");
  const fd = `${f.getUTCDate()} ${MONTHS[f.getUTCMonth()]}`;
  const td = `${t.getUTCDate()} ${MONTHS[t.getUTCMonth()]}`;
  if (from === to) return td;
  if (f.getUTCMonth() === t.getUTCMonth() && f.getUTCFullYear() === t.getUTCFullYear()) {
    return `${f.getUTCDate()}–${td}`;
  }
  return `${fd} – ${td}`;
}

/** Evidence label wording required by the spec: "Compared with 12 listings sampled on 10 Nov". */
export function sampleEvidenceLabel(stats: SampleStats): string {
  const range = formatDateRange(stats.collectedOn.from, stats.collectedOn.to);
  const base = `Compared with ${stats.n} listings sampled on ${range}`;
  return stats.placeholder ? `${base} (placeholder data, not real listings)` : base;
}
