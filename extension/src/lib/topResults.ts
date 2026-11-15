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

export function topResults(
  cards: SurveyCard[],
  opts: {
    profile: Profile | null;
    /** The search the cards came from ("nike pegasus 40"). */
    query?: string;
    /** The listing being investigated, never offered back. */
    excludeId?: string | null;
    /** The buyer's "Colour or look" for this pair. */
    colourWish?: string;
    limit?: number;
  },
): TopResult[] {
  const eligible = cards.filter(
    (c) => !c.sponsored && c.buyingFormat !== "auction" && c.price !== null && c.price > 0 && (c.currency === null || c.currency === "GBP") && c.id !== opts.excludeId && /^https:\/\//.test(c.url),
  );
  if (!eligible.length) return [];
  const typical = median(eligible.map((c) => c.price!));
  const hasSizes = !!(opts.profile?.sizes.length || opts.profile?.defaultSize);
  const queryWords = words(opts.query ?? "");
  const { wanted, avoided } = wishColours(opts.colourWish);

  const scored: TopResult[] = [];
  for (const c of eligible) {
    const price = c.price!;
    // Only at or under the typical price is "high potential" (with a handful of cards there is little to compare).
    if (eligible.length >= 4 && price > typical) continue;
    const fit = cardSizeFit(c, opts.profile);
    // A size we can read that isn't the buyer's is no use to them.
    if (hasSizes && fit.cardUK !== null && fit.mineUK !== null && !fit.fits) continue;

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

    if (queryWords.length) {
      const title = new Set(words(c.title));
      score += (queryWords.filter((w) => title.has(w)).length / queryWords.length) * 15;
    }
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
    scored.push({ card: c, score: Math.round(score * 10) / 10, reason: parts.join(" · "), sizeLabel, typicalGBP: Math.round(typical * 100) / 100 });
  }
  return scored.sort((a, b) => b.score - a.score || a.card.price! - b.card.price! || a.card.id.localeCompare(b.card.id)).slice(0, opts.limit ?? TOP_RESULTS);
}
