import type { SizeSystem } from "@/schemas/domain";
import type { CatalogueModel, SizeChart } from "@/schemas/seed";
import { convertSize } from "./sizes";

/**
 * Title matching for surveyed listings (Feature A3). Shared by the backend (run after identify, against the identified
 * model) and the extension (the survey summary). Plain code, no model involved: a listing title is normalised, its size
 * pulled out, and its words compared with the model's tokens (brand, family, optional version, exclusions).
 */

export type MatchLevel = "exact" | "version_unknown" | "different_version" | "none";
export const MATCH_LEVELS: MatchLevel[] = ["exact", "version_unknown", "different_version", "none"];

/** brand: one normalised token ("nike", "newbalance"). version: null when the model has none (any version is the model). */
export type ModelTokens = { brand: string; family: string[]; version: string | null; exclude: string[] };

/** Tokens that make a title a different product whatever else it says (kids' sizes, trail and waterproof variants). */
export const SHARED_EXCLUSIONS = ["trail", "shield", "gtx", "goretex", "junior", "gs", "kids", "kid", "toddler", "infant"];

const NOISE = new Set([
  "mens", "men", "womens", "women", "trainers", "trainer", "shoes", "shoe", "sneakers", "sneaker", "size", "new", "bnwt", "bnib",
  "rare", "authentic", "genuine",
  // common colour words
  "black", "white", "grey", "gray", "red", "blue", "green", "yellow", "orange", "pink", "purple", "brown", "beige", "cream", "navy",
  "silver", "gold", "tan", "khaki", "olive", "multi", "multicolour", "multicolor",
]);

/** Spelling variants, applied to the normalised text (whole words only). */
const VARIANTS: [RegExp, string][] = [
  [/\bair zoom pegasus\b/g, "pegasus"],
  [/\bzoom pegasus\b/g, "pegasus"],
  [/\bpeg\b/g, "pegasus"],
  [/\bultra boost\b/g, "ultraboost"],
  [/\bnova blast\b/g, "novablast"],
  [/\bcloud monster\b/g, "cloudmonster"],
  [/\bnew balance\b/g, "newbalance"],
  [/\bnb\b/g, "newbalance"],
  [/\bhoka one one\b/g, "hoka"],
  [/\bon running\b/g, "on"],
  [/\bair force one\b/g, "air force 1"],
  [/\baf 1\b/g, "air force 1"],
  [/\bairmax\b/g, "air max"],
  [/\bam 90\b/g, "air max 90"],
  [/\bchuck taylor\b/g, "chuck"],
  [/\bct 70\b/g, "chuck 70"],
];

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14, xv: 15 };

const FRACTIONS: Record<string, string> = { "½": ".5", "¼": ".25", "¾": ".75", "⅓": ".33", "⅔": ".67" };

// Fractions first: NFKD would turn "½" into "1⁄2".
const lower = (s: string) =>
  s
    .replace(/(\d)\s*([½¼¾⅓⅔])/g, (_, d, f) => d + FRACTIONS[f])
    .replace(/[½¼¾⅓⅔]/g, (f) => `0${FRACTIONS[f]}`)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");

/**
 * Lowercase, strip punctuation, collapse whitespace, split glued words and numbers ("pegasus40"), apply spelling
 * variants and drop noise words. Sizes should be removed first (extractSize), or their numbers stay in the text.
 */
export function normaliseTitle(title: string): string {
  let s = lower(title)
    .replace(/['’`]/g, "")
    .replace(/\bgore[\s-]*tex\b/g, "goretex")
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/(^|[^0-9])\.|\.(?![0-9])/g, "$1 ") // dots only survive inside numbers
    .replace(/\b([a-z]{2,})(\d+)\b/g, "$1 $2") // pegasus40 -> pegasus 40 (v13 stays whole)
    .replace(/\b(\d+)(v\d+)\b/g, "$1 $2") // 1080v13 -> 1080 v13
    .replace(/\s+/g, " ")
    .trim();
  for (const [re, to] of VARIANTS) s = s.replace(re, to);
  return s
    .split(" ")
    .filter((w) => w && !NOISE.has(w))
    .join(" ");
}

export function tokenise(title: string): string[] {
  const n = normaliseTitle(title);
  return n ? n.split(" ") : [];
}

// ---------- sizes ----------

export type TitleSize = { system: SizeSystem; value: number; assumed: boolean; start: number; end: number };

const NUM = String.raw`(\d{1,2}(?:\.\d{1,2})?)`;
const SYS = String.raw`(uk|us|eur|eu)`;
const SIZE_PATTERNS: { re: RegExp; sys: number; num: number }[] = [
  // "uk 9", "uk9", "uk size 9", "uk shoe size: 9", "eu 43", "us 10"
  { re: new RegExp(String.raw`\b${SYS}\s*(?:shoe\s*)?(?:size\s*)?[:\-]?\s*${NUM}(?![\d.])`, "g"), sys: 1, num: 2 },
  // "size 9", "size: 9.5", "size uk 9" (system optional)
  { re: new RegExp(String.raw`\bsize\s*[:\-]?\s*(?:${SYS}\s*)?${NUM}(?![\d.])`, "g"), sys: 1, num: 2 },
  // "9uk", "9 uk", "10us", "43eu"
  { re: new RegExp(String.raw`(?<![\d.])${NUM}\s*${SYS}\b`, "g"), sys: 2, num: 1 },
];

const toSystem = (s: string | undefined): SizeSystem | null => (!s ? null : s === "eur" || s === "eu" ? "EU" : (s.toUpperCase() as SizeSystem));

/**
 * The first size stated in a title or a card's size text: "uk 9", "size 9", "9uk", "us 10", "eu 43". A bare size with
 * no system is UK below 35 and EU from 35 (`assumed`). `bareOk` also reads a lone number ("43", "9.5"), for size fields.
 */
export function extractSize(text: string | undefined, opts: { bareOk?: boolean } = {}): TitleSize | null {
  if (!text) return null;
  const t = lower(text);
  // Patterns in priority order ("pegasus 40 uk 9" is UK 9, not "40 uk"); a size with a stated system beats a bare one.
  let best: TitleSize | null = null;
  for (const p of SIZE_PATTERNS) {
    p.re.lastIndex = 0;
    for (let m = p.re.exec(t); m; m = p.re.exec(t)) {
      const value = Number(m[p.num]);
      if (!(value > 0 && value < 60)) continue;
      const stated = toSystem(m[p.sys]);
      const hit = { system: stated ?? (value >= 35 ? "EU" : "UK"), value, assumed: !stated, start: m.index, end: m.index + m[0].length } as TitleSize;
      if (!hit.assumed) return hit;
      best ??= hit;
      break;
    }
  }
  if (!best && opts.bareOk) {
    const m = /^\s*(\d{1,2}(?:\.\d{1,2})?)\s*$/.exec(t);
    const value = m ? Number(m[1]) : NaN;
    if (value > 0 && value < 60) best = { system: value >= 35 ? "EU" : "UK", value, assumed: true, start: 0, end: t.length };
  }
  return best;
}

/** The title with its size text removed (so "uk 9" isn't read as version 9). Works on the lowercased text. */
export function withoutSize(title: string): string {
  const t = lower(title);
  const s = extractSize(t);
  return s ? `${t.slice(0, s.start)} ${t.slice(s.end)}` : t;
}

/** A size converted to UK on the brand's chart; UK sizes need no chart. Null when it isn't on the chart. */
export function toUK(size: { system: SizeSystem; value: number }, chart: SizeChart | undefined): number | null {
  if (size.system === "UK") return size.value;
  if (!chart) return null;
  return convertSize(size.value, size.system, chart)?.uk ?? null;
}

/** The chart for a brand (by normalised brand token), if any. */
export function chartForBrand(brand: string | null | undefined, charts: SizeChart[]): SizeChart | undefined {
  if (!brand) return undefined;
  const b = brandToken(brand);
  return charts.find((c) => brandToken(c.brand) === b);
}

// ---------- model tokens ----------

export const brandToken = (brand: string) => normaliseTitle(brand).replace(/\s+/g, "");

const isVersionToken = (t: string) => /^\d{1,4}$/.test(t) || /^v\d{1,3}$/.test(t) || t in ROMAN;

/** "v13" -> "13", "iv" -> "4", "07" -> "7". */
export function canonicalVersion(v: string): string {
  const t = v.toLowerCase().replace(/^v(?=\d)/, "");
  if (t in ROMAN) return String(ROMAN[t]);
  return /^\d+$/.test(t) ? String(Number(t)) : t;
}

/**
 * Tokens for a model outside the catalogue, from identify's brand and model name: the family words, with a trailing
 * number or roman numeral as the version, plus the shared exclusions (minus any the model's own name uses).
 */
export function deriveTokens(brand: string, modelName: string): ModelTokens {
  const b = brandToken(brand);
  const words = tokenise(modelName).filter((w) => w !== b);
  let version: string | null = null;
  if (words.length > 1 && isVersionToken(words[words.length - 1])) version = words.pop()!;
  return { brand: b, family: words, version, exclude: SHARED_EXCLUSIONS.filter((x) => !words.includes(x)) };
}

/** A catalogue model's tokens: its stored matchTokens when present, otherwise derived from its name. */
export function catalogueTokens(m: CatalogueModel): ModelTokens {
  if (!m.matchTokens) return deriveTokens(m.brand, m.name);
  const family = m.matchTokens.family.map((t) => t.toLowerCase());
  const own = (m.matchTokens.exclude ?? []).map((t) => t.toLowerCase());
  return {
    brand: brandToken(m.brand),
    family,
    version: m.matchTokens.version ? m.matchTokens.version.toLowerCase() : null,
    exclude: [...new Set([...SHARED_EXCLUSIONS, ...own])].filter((x) => !family.includes(x)),
  };
}

/** Levenshtein distance capped at 2 (only "0, 1 or more" matters here). */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 1) return 2;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return Math.min(prev[b.length], 2);
}

/** A family token matches exactly, or with one letter wrong when it has 5+ letters (never a number or version). */
function familyHit(word: string, token: string): boolean {
  if (word === token) return true;
  if (token.length < 5 || !/^[a-z]+$/.test(token) || !/^[a-z]+$/.test(word)) return false;
  return editDistance(word, token) <= 1;
}

export type TitleMatch = { level: MatchLevel; titleVersion: string | null };

/**
 * exact: brand, every family token, the same version (or the model has none), no exclusion token.
 * version_unknown: brand and family, but the title gives no version. different_version: brand and family, another version.
 * none: anything else, including titles that don't name a model. The version is the token right after the family.
 */
export function matchTitle(title: string, model: ModelTokens): TitleMatch {
  const words = tokenise(withoutSize(title));
  const none: TitleMatch = { level: "none", titleVersion: null };
  if (!model.family.length || !words.includes(model.brand)) return none;
  if (words.some((w) => model.exclude.includes(w))) return none;
  let last = -1;
  for (const token of model.family) {
    const at = words.findIndex((w) => familyHit(w, token));
    if (at < 0) return none;
    last = Math.max(last, at);
  }
  const next = words[last + 1];
  const titleVersion = next && isVersionToken(next) ? next : null;
  if (model.version === null) return { level: "exact", titleVersion };
  if (titleVersion === null) return { level: "version_unknown", titleVersion };
  return { level: canonicalVersion(titleVersion) === canonicalVersion(model.version) ? "exact" : "different_version", titleVersion };
}

/** Does the title name any of these models (at any level but none)? Used for the survey's "couldn't be matched" count. */
export function namesAnyModel(title: string, models: ModelTokens[]): boolean {
  return models.some((m) => matchTitle(title, m).level !== "none");
}
