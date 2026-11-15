import type { Profile } from "@/schemas/domain";
import { colourWordsIn } from "@/lib/colourWords";
import { normaliseTitle } from "@/lib/titleMatch";
import { gbp } from "./format";
import { cardSizeFit, type SurveyCard } from "./survey";

/**
 * "Best value for you": from a search page's hundreds of cards, the few worth a look. Same platform, a link, a plain GBP
 * price, not sponsored, not an auction. Ranked mainly by how far the price sits below the page's typical (median) price,
 * then the buyer's size, how well the title matches the search words, and the buyer's colour or look. Pure; nothing is
 * fetched and nothing leaves the device.
 */

export const TOP_RESULTS = 8;

export type TopResult = {
  card: SurveyCard;
  score: number;
  /** "£12 under typical · UK 9 · white in the title" */
  reason: string;
  sizeLabel: string;
  /** Typical (median) price of the eligible cards, for "£12 under typical". */
  typicalGBP: number | null;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const NEGATION = /\b(no|not|without|avoid|nothing|never|non)\b/i;

/** "all white, nothing neon" -> wanted colours (white) and avoided colours, clause by clause. */
export function wishColours(wish: string | undefined): { wanted: string[]; avoided: string[] } {
  const wanted: string[] = [];
  const avoided: string[] = [];
  for (const clause of (wish ?? "").split(/[;,\n]|\bbut\b/i)) {
    const colours = colourWordsIn(clause);
    (NEGATION.test(clause) ? avoided : wanted).push(...colours);
  }
  return { wanted: [...new Set(wanted)], avoided: [...new Set(avoided)] };
}

const words = (s: string) => normaliseTitle(s).split(" ").filter((w) => w.length > 1);

/** What was read and what was left out, for the line that explains the list (and an empty one). */
export type ResultCounts = {
  read: number;
  /** Results ranked (before paging). */
  ranked: number;
  sponsored: number;
  auctions: number;
  /** No single price: a price range, or none. */
  unpriced: number;
  otherCurrency: number;
  /** The listing being investigated. */
  self: number;
  aboveTypical: number;
  otherSize: number;
  typicalGBP: number | null;
};

type Opts = {
  profile: Profile | null;
  /** The search the cards came from ("nike pegasus 40"). */
  query?: string;
  /** The listing being investigated, never offered back. */
  excludeId?: string | null;
  /** The buyer's "Colour or look" for this pair. */
  colourWish?: string;
  limit?: number;
};

const queryOverlap = (queryWords: string[], title: string) => {
  const t = new Set(words(title));
  return queryWords.length ? queryWords.filter((w) => t.has(w)).length / queryWords.length : 1;
};

/** Every card scored and sorted, plus the counts behind what was left out. */
export function analyseResults(cards: SurveyCard[], opts: Opts): { ranked: TopResult[]; counts: ResultCounts } {
  const counts: ResultCounts = { read: cards.length, ranked: 0, sponsored: 0, auctions: 0, unpriced: 0, otherCurrency: 0, self: 0, aboveTypical: 0, otherSize: 0, typicalGBP: null };
  const eligible: SurveyCard[] = [];
  for (const c of cards) {
    if (c.id === opts.excludeId) counts.self++;
    else if (!/^https:\/\//.test(c.url)) continue;
    else if (c.sponsored) counts.sponsored++;
    else if (c.buyingFormat === "auction") counts.auctions++;
    else if (c.price === null || c.price <= 0) counts.unpriced++;
    else if (c.currency !== null && c.currency !== "GBP") counts.otherCurrency++;
    else eligible.push(c);
  }
  if (!eligible.length) return { ranked: [], counts };
  const queryWords = words(opts.query ?? "");
  // "Typical" is the price of listings that are about the search, not of whatever else sits on the page.
  const onTopic = queryWords.length >= 2 ? eligible.filter((c) => queryOverlap(queryWords, c.title) > 0) : eligible;
  const typical = median((onTopic.length ? onTopic : eligible).map((c) => c.price!));
  counts.typicalGBP = Math.round(typical * 100) / 100;
  const hasSizes = !!(opts.profile?.sizes.length || opts.profile?.defaultSize);
  const { wanted, avoided } = wishColours(opts.colourWish);

  const scored: TopResult[] = [];
  for (const c of eligible) {
    const price = c.price!;
    // Only at or under the typical price is "high potential" (with a handful of cards there is little to compare).
    if (eligible.length >= 4 && price > typical) {
      counts.aboveTypical++;
      continue;
    }
    const fit = cardSizeFit(c, opts.profile);
    // A size we can read that isn't the buyer's is no use to them.
    if (hasSizes && fit.cardUK !== null && fit.mineUK !== null && !fit.fits) {
      counts.otherSize++;
      continue;
    }

    const parts: string[] = [];
    let score = 0;
    const under = typical - price;
    score += Math.max(-30, Math.min(48, (under / typical) * 60));
    parts.push(under >= 3 ? `${gbp(Math.round(under))} under typical` : "Around the typical price");

    let sizeLabel = "Size not stated";
    if (fit.cardUK !== null) {
      sizeLabel = `UK ${fit.cardUK}`;
      if (fit.fits) score += 20;
    } else if (hasSizes) score += 4; // unknown size: worth asking, but less than a known match
    parts.push(sizeLabel);

    if (queryWords.length) score += queryOverlap(queryWords, c.title) * 15;
    if (wanted.length || avoided.length) {
      const inTitle = colourWordsIn(c.title);
      if (avoided.some((a) => inTitle.includes(a as never))) {
        score -= 25;
        parts.push(`${avoided.find((a) => inTitle.includes(a as never))} in the title`);
      } else if (wanted.some((w) => inTitle.includes(w as never))) {
        score += 12;
        parts.push(`${wanted.find((w) => inTitle.includes(w as never))} in the title`);
      } else if (wanted.length && inTitle.length) score -= 8;
    }
    if (c.thumbnailUrl) score += 3;
    scored.push({ card: c, score: Math.round(score * 10) / 10, reason: parts.join(" · "), sizeLabel, typicalGBP: counts.typicalGBP });
  }
  const ranked = scored.sort((a, b) => b.score - a.score || a.card.price! - b.card.price! || a.card.id.localeCompare(b.card.id));
  counts.ranked = ranked.length;
  return { ranked, counts };
}

export function topResults(cards: SurveyCard[], opts: Opts): TopResult[] {
  return analyseResults(cards, opts).ranked.slice(0, opts.limit ?? TOP_RESULTS);
}

/** How many ranked results the search screen keeps to page through ("Show next 8"). */
export const RANKED_MAX = 40;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Read 58 listings. 12 look like good value; left out: 20 not in your size, 9 auctions or sponsored, ..." Never silent. */
export function explainResults(c: ResultCounts): string {
  if (!c.read) return "No listings read from this page yet.";
  const left: string[] = [];
  if (c.otherSize) left.push(`${c.otherSize} not in your size`);
  if (c.aboveTypical) left.push(`${c.aboveTypical} above the typical ${c.typicalGBP !== null ? gbp(Math.round(c.typicalGBP)) : "price"}`);
  const noFixedPrice = c.auctions + c.sponsored;
  if (noFixedPrice) left.push(`${noFixedPrice} ${noFixedPrice === 1 ? "auction or sponsored" : "auctions or sponsored"}`);
  if (c.unpriced) left.push(`${c.unpriced} with no single price`);
  if (c.otherCurrency) left.push(`${c.otherCurrency} not priced in £`);
  const head = `Read ${plural(c.read, "listing")}. ${c.ranked ? `${c.ranked} look like good value` : "None stood out as good value"}`;
  return left.length ? `${head}; left out: ${left.join(", ")}.` : `${head}.`;
}
