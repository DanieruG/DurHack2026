import type { CheckName, CheckResult, Evidence } from "@/schemas/domain";

/** Banned in ALL generated text (spec 7.9 / 13). Stems catch "scammer", "faked", "ripoff", "guarantee". */
export const BANNED_WORDS = ["scam", "fake", "fraud", "liar", "rip-off", "guaranteed", "counterfeit", "replica", "rep"] as const;
const BANNED_RE = /\b(scam\w*|fake\w*|fraud\w*|liars?|rip[\s-]?offs?|guarantee\w*|counterfeit\w*|replicas?|reps?)\b/i;

export function containsBanned(text: string): boolean {
  return BANNED_RE.test(text);
}

export function bannedIn(text: string): string | null {
  const m = BANNED_RE.exec(text);
  return m ? m[0] : null;
}

const CHECK_KEYWORDS: Record<CheckName, RegExp> = {
  identify: /\b(model|identif\w*|label|which shoe|tongue)\b/i,
  fit: /\b(fit|fits|size|sizing|sizes|small|large)\b/i,
  price: /(£|\bprice\w*|\bcost\w*|\bnew\b|\bsampled\b|\blistings\b|\bvalue\b)/i,
  comfort: /\b(comfort\w*|reviews?|reviewers|cushion\w*|width|wide|narrow)\b/i,
  condition: /\b(condition|wear|worn|photos?|defects?|crease\w*|sole|scuff\w*|stain\w*|damage\w*)\b/i,
  colour: /\b(colou?rs?|colourway|shade|looks?)\b/i,
};

const PRICE_MENTION = /(£\s?\d|\bprice\w*\b|\bcosts?\b|\bcheap\w*\b|\bexpensive\b|\bbargain\b|\boverpriced\b)/i;
const PRICE_SOURCE = /\b(sampled|listings|new price|buying new|brand new|new at|retail\w*|RRP|couldn'?t find|could not find|no reliable)\b/i;

export function sentenceCount(text: string): number {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => /[a-z0-9]/i.test(s)).length;
}

/** Every number that may appear in generated text: numbers present in evidence, summaries and details. */
function allowedNumbers(checks: CheckResult[], evidence: Record<string, Evidence>): Set<string> {
  const corpus = [
    ...checks.map((c) => `${c.summary} ${JSON.stringify(c.details ?? {})}`),
    ...Object.values(evidence).map((e) => `${e.label} ${e.quote ?? ""} ${e.value ?? ""} ${e.observedOn ?? ""}`),
  ].join(" ");
  const set = new Set<string>();
  for (const m of corpus.matchAll(/\d+(?:\.\d+)?/g)) set.add(String(Number(m[0])));
  return set;
}

export type GeneratedText = { headline: string; explanation: string; citedEvidenceIds: string[] };

/**
 * Verdict validator (spec 7.9): cited ids exist; every fail/warn check is mentioned; no numeric facts beyond the
 * evidence; price claims mention their source; banned words; 2-4 sentences. Returns a list of problems.
 */
export function validateVerdictText(
  text: GeneratedText,
  ctx: { checks: CheckResult[]; evidence: Record<string, Evidence> },
): string[] {
  const errors: string[] = [];
  const all = `${text.headline} ${text.explanation}`;
  const banned = bannedIn(all);
  if (banned) errors.push(`Banned word used: "${banned}"`);
  if (!text.headline.trim()) errors.push("Headline is empty");
  if (text.headline.length > 100) errors.push("Headline is longer than 100 characters");
  const n = sentenceCount(text.explanation);
  if (n < 2 || n > 4) errors.push(`Explanation must be 2-4 sentences (got ${n})`);

  const missing = text.citedEvidenceIds.filter((id) => !ctx.evidence[id]);
  if (missing.length) errors.push(`Cited evidence ids do not exist: ${missing.join(", ")}`);
  if (Object.keys(ctx.evidence).length > 0 && text.citedEvidenceIds.length === 0) errors.push("No evidence cited");

  for (const c of ctx.checks) {
    if (c.status !== "fail" && c.status !== "warn") continue;
    const cites = c.evidence.some((e) => text.citedEvidenceIds.includes(e.id));
    if (!cites && !CHECK_KEYWORDS[c.check].test(all)) errors.push(`The ${c.check} check (${c.status}) is not mentioned`);
  }

  if (PRICE_MENTION.test(all) && !PRICE_SOURCE.test(all)) {
    errors.push("Price claims must say where they come from (sampled listings with date, or current new price)");
  }

  const allowed = allowedNumbers(ctx.checks, ctx.evidence);
  const unsupported = [...all.matchAll(/\d+(?:\.\d+)?/g)].map((m) => String(Number(m[0]))).filter((x) => !allowed.has(x));
  if (unsupported.length) errors.push(`Numbers not found in the evidence: ${[...new Set(unsupported)].join(", ")}`);

  return errors;
}

const ACCUSATORY = /\b(lying|lie|lied|dishonest|cheat\w*|prove it|you claim|admit|suspicious of you|stolen)\b/i;

/** Next-move validator: banned words, accusatory phrasing, length; ask_seller must be a question. */
export function validateNextMoveText(text: string, kind: "ask_seller" | "before_you_pay"): string[] {
  const errors: string[] = [];
  const banned = bannedIn(text);
  if (banned) errors.push(`Banned word used: "${banned}"`);
  if (ACCUSATORY.test(text)) errors.push("Accusatory phrasing");
  if (!text.trim()) errors.push("Empty");
  if (text.length > 320) errors.push("Too long");
  if (kind === "ask_seller" && !text.trim().endsWith("?")) errors.push("A seller question must end with a question mark");
  return errors;
}
