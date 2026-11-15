import type {
  ListingFacts,
  MatchCounts,
  ObservedAlternative,
  ObservedAlternatives,
  ObservedComparison,
  ObservedListing,
  ObservedSuggestion,
  Platform,
  SampleStats,
  UserNeeds,
} from "@/schemas/domain";
import type { SizeChart } from "@/schemas/seed";
import { detectPlatform } from "./platform";
import { listingItemId } from "./listingScope";
import { excludeOutliers, percentile } from "./priceSample";
import { convertSize, rowForCm } from "./sizes";
import { chartForBrand, extractSize, matchTitle, toUK, type MatchLevel, type ModelTokens } from "./titleMatch";

/**
 * Source C, observed listings (Feature A5/A6): listings from the user's own survey of a search on the same platform,
 * matched to the identified model after identify. Asking prices from one search, so confidence stays modest. Only
 * listings the user has seen are used, never a wider search.
 */

export const MIN_OBSERVED_MATCHES = 5;
export const OBSERVED_CONFIDENCE_CAP = 0.6;
/** Version unclear: family-level context only, price confidence capped here. */
export const FAMILY_CONFIDENCE_CAP = 0.4;
export const MAX_SUGGESTIONS = 2;
/** A suggestion must be cheaper by at least this much: 10% of the listing's price or £5, whichever is larger. */
export const SUGGESTION_MIN_SAVING = { fraction: 0.1, gbp: 5 } as const;
/** Below UK 3 is a child's size: left out of "all adult sizes". */
export const ADULT_MIN_UK = 3;
export const MODEL_UNKNOWN_NOTE = "Couldn't compare: model unknown.";

export type PriceBasis = "listed" | "excl_buyer_protection";

/** A surveyed card that can be compared: GBP price, same platform, not an auction, not the listing being investigated. */
export type SurveyListing = {
  id: string;
  title: string;
  priceGBP: number;
  url: string;
  thumbnailUrl?: string;
  sizeText?: string;
  sponsored: boolean;
  /** When the card was surveyed (YYYY-MM-DD). */
  seenOn?: string;
  /** What the buyer pays (item, buyer protection and postage), when the card gives it. Surveyed cards don't yet. */
  totalGBP?: number;
};

export type Survey = {
  searchQuery: string | null;
  platform: Platform;
  /** YYYY-MM-DD of the most recent card. */
  surveyedOn: string;
  priceBasis: PriceBasis;
  /** Cards received for this platform, minus the listing being investigated. */
  surveyed: number;
  auctionsExcluded: number;
  /** No price, or not in GBP, or a different price basis. */
  unpricedExcluded: number;
  /** How many cards were usable for matching (listings.length for a fresh survey; more than that for a stored subset). */
  usable: number;
  listings: SurveyListing[];
};

export type MatchedListing = SurveyListing & { level: MatchLevel; sizeUK: number | null; sizeLabel: string | null };

/** What is stored with the case: the matched subset only (no unmatched cards), with each card's match level. */
export type StoredSurvey = Omit<Survey, "listings"> & {
  counts: MatchCounts;
  listings: (Pick<SurveyListing, "id" | "title" | "priceGBP" | "url" | "thumbnailUrl" | "sizeText" | "sponsored" | "seenOn" | "totalGBP"> & { matchLevel: MatchLevel })[];
};

export const sanitiseQuery = (q: string | undefined | null) => {
  const t = (q ?? "").replace(/[\u0000-\u001f"“”]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  return t || null;
};

function samePath(a: string, b: string | undefined): boolean {
  if (!b) return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.host === y.host && x.pathname.replace(/\/+$/, "") === y.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

/**
 * Turn the capture's observed listings into a survey: dedupe by listing id (latest card wins), keep only the case's
 * platform, drop the listing being investigated, exclude auctions (Buy It Now prices only) and cards without a GBP price,
 * and keep one consistent price basis. Null when nothing is left to look at.
 */
export function prepareSurvey(
  observed: ObservedListing[] | undefined,
  ctx: { platform: Platform; pageUrl?: string; searchQuery?: string },
): Survey | null {
  if (!observed?.length) return null;
  const byId = new Map<string, ObservedListing>();
  for (const o of observed) {
    const prev = byId.get(o.id);
    if (!prev || prev.seenAt <= o.seenAt) byId.set(o.id, o);
  }
  const currentId = ctx.pageUrl ? listingItemId(ctx.pageUrl, ctx.platform) : null;
  const cards = [...byId.values()].filter(
    (o) => detectPlatform(o.url) === ctx.platform && o.id !== currentId && !samePath(o.url, ctx.pageUrl),
  );
  if (!cards.length) return null;
  const notAuction = cards.filter((o) => o.buyingFormat !== "auction");
  const basisVotes = notAuction.reduce((n, o) => n + (o.priceBasis === "excl_buyer_protection" ? 1 : -1), 0);
  const priceBasis: PriceBasis = basisVotes > 0 ? "excl_buyer_protection" : "listed";
  const priced = notAuction.filter(
    (o) => o.price !== null && o.price > 0 && (!o.currency || /^(gbp|£)$/i.test(o.currency.trim())) && o.priceBasis === priceBasis,
  );
  const listings: SurveyListing[] = priced.map((o) => ({
    id: o.id,
    title: o.title,
    priceGBP: o.price!,
    url: o.url,
    ...(o.thumbnailUrl ? { thumbnailUrl: o.thumbnailUrl } : {}),
    ...(o.sizeText ? { sizeText: o.sizeText } : {}),
    sponsored: o.sponsored,
    seenOn: o.seenAt.slice(0, 10),
  }));
  return {
    searchQuery: sanitiseQuery(ctx.searchQuery),
    platform: ctx.platform,
    surveyedOn: cards.map((o) => o.seenAt.slice(0, 10)).sort().at(-1)!,
    priceBasis,
    surveyed: cards.length,
    auctionsExcluded: cards.length - notAuction.length,
    unpricedExcluded: notAuction.length - priced.length,
    usable: listings.length,
    listings,
  };
}

/** A card's size, from its size field first, else its title; converted to UK on the brand's chart. */
export function cardSize(l: Pick<SurveyListing, "title" | "sizeText">, chart: SizeChart | undefined): { sizeUK: number | null; sizeLabel: string | null } {
  const s = extractSize(l.sizeText, { bareOk: true }) ?? extractSize(l.title);
  if (!s) return { sizeUK: null, sizeLabel: null };
  const uk = toUK(s, chart);
  return { sizeUK: uk, sizeLabel: uk !== null ? `UK ${uk}` : `${s.system} ${s.value}` };
}

/** Match every card to the model (tokens null: the model is unknown, so nothing matches). */
export function matchSurvey(survey: Survey, tokens: ModelTokens | null, chart: SizeChart | undefined): MatchedListing[] {
  return survey.listings.map((l) => ({ ...l, level: tokens ? matchTitle(l.title, tokens).level : "none", ...cardSize(l, chart) }));
}

export function levelCounts(survey: Survey, matched: MatchedListing[]): MatchCounts {
  const counts: MatchCounts = { exact: 0, version_unknown: 0, different_version: 0, none: 0 };
  for (const m of matched) if (m.level !== "none") counts[m.level]++;
  counts.none = Math.max(0, survey.usable - counts.exact - counts.version_unknown - counts.different_version);
  return counts;
}

/** The matched subset to store with the case: id, title, price, URL, thumbnail, size and match level. */
export function toStoredSurvey(survey: Survey, matched: MatchedListing[]): StoredSurvey {
  const { listings: _all, ...rest } = survey;
  return {
    ...rest,
    counts: levelCounts(survey, matched),
    listings: matched
      .filter((m) => m.level !== "none")
      .map((m) => ({
        id: m.id,
        title: m.title,
        priceGBP: m.priceGBP,
        url: m.url,
        ...(m.thumbnailUrl ? { thumbnailUrl: m.thumbnailUrl } : {}),
        ...(m.sizeText ? { sizeText: m.sizeText } : {}),
        sponsored: m.sponsored,
        ...(m.seenOn ? { seenOn: m.seenOn } : {}),
        ...(m.totalGBP !== undefined ? { totalGBP: m.totalGBP } : {}),
        matchLevel: m.level,
      })),
  };
}

/** A stored subset as a survey again (reopen): its cards are re-matched against whatever identify now says. */
export function fromStoredSurvey(s: StoredSurvey): Survey {
  const { counts: _c, listings, ...rest } = s;
  return { ...rest, listings: listings.map(({ matchLevel: _m, ...l }) => l) };
}

// ---------- the user's size ----------

const sameBrand = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The user's size in UK on the model's chart: their saved size for this brand, else another brand's size by foot length. */
export function userSizeUK(needs: UserNeeds, brand: string, chart: SizeChart | undefined, charts: SizeChart[]): number | null {
  const own = needs.sizes.find((s) => sameBrand(s.brand, brand));
  if (own) return own.system === "UK" ? own.size : chart ? (convertSize(own.size, own.system, chart)?.uk ?? null) : null;
  for (const s of needs.sizes) {
    const theirs = chartForBrand(s.brand, charts);
    const row = theirs ? convertSize(s.size, s.system, theirs) : null;
    const mapped = row && chart ? rowForCm(row.cm, chart) : null;
    if (mapped) return mapped.uk;
  }
  return null;
}

// ---------- Source C, context and suggestions ----------

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `£${Number.isInteger(n) ? n : n.toFixed(2)}`;
const isAdult = (m: MatchedListing) => m.sizeUK === null || m.sizeUK >= ADULT_MIN_UK;

/** Source C: exact matches, all adult sizes, outlier rule as for the catalogue sample; null below 5 matches. */
export function observedStats(matched: MatchedListing[], surveyedOn: string): SampleStats | null {
  const prices = matched.filter((m) => m.level === "exact" && isAdult(m)).map((m) => m.priceGBP);
  const { kept, excluded } = excludeOutliers(prices);
  if (kept.length < MIN_OBSERVED_MATCHES) return null;
  const sorted = [...kept].sort((a, b) => a - b);
  return {
    n: kept.length,
    excluded,
    median: percentile(sorted, 50),
    p10: percentile(sorted, 10),
    p25: percentile(sorted, 25),
    p75: percentile(sorted, 75),
    p90: percentile(sorted, 90),
    collectedOn: { from: surveyedOn, to: surveyedOn },
    ruleIds: ["observed_listings"],
    placeholder: false,
  };
}

export function observedConfidence(stats: SampleStats): number {
  return Math.min(OBSERVED_CONFIDENCE_CAP, round2(0.4 + stats.n * 0.02));
}

/**
 * Context when Source C can't be used: "{n} similar listings seen, £{min} to £{max}". Model known: exact and
 * version-not-stated matches (labelled). Family only (version unclear): every listing naming the family.
 */
export function observedContext(matched: MatchedListing[], opts: { familyLevel: boolean }): NonNullable<ObservedComparison["context"]> | null {
  const pool = matched.filter((m) => (opts.familyLevel ? m.level !== "none" : m.level === "exact" || m.level === "version_unknown"));
  if (!pool.length) return null;
  const prices = pool.map((m) => m.priceGBP);
  const minGBP = Math.min(...prices);
  const maxGBP = Math.max(...prices);
  const exact = pool.filter((m) => m.level === "exact").length;
  const versionUnknown = pool.filter((m) => m.level === "version_unknown").length;
  const range = minGBP === maxGBP ? money(minGBP) : `${money(minGBP)} to ${money(maxGBP)}`;
  const noun = pool.length === 1 ? "listing" : "listings";
  let line = `${pool.length} similar ${noun} seen, ${range}`;
  if (opts.familyLevel) line += " (same model family, any version)";
  else if (versionUnknown) line += ` (${exact} exact, ${versionUnknown} not stating the version)`;
  return { n: pool.length, minGBP, maxGBP, exact, versionUnknown, familyLevel: opts.familyLevel, line };
}

export function minSaving(price: number): number {
  return Math.max(SUGGESTION_MIN_SAVING.fraction * price, SUGGESTION_MIN_SAVING.gbp);
}

const httpsOnly = (u: string | undefined) => (u && /^https:\/\//i.test(u) ? u : undefined);

/**
 * Up to 2 cheaper surveyed listings: exact matches, in the user's size or with no size stated (flagged), not auctions
 * (already excluded), cheaper by at least 10% or £5, whichever is larger. Cheapest first. Without a saved size, any size.
 */
export function suggestCheaper(matched: MatchedListing[], args: { price: number; userSizeUK: number | null; platform: Platform }): ObservedSuggestion[] {
  const need = minSaving(args.price);
  return matched
    .filter((m) => m.level === "exact" && isAdult(m))
    .filter((m) => args.price - m.priceGBP >= need - 1e-9)
    .filter((m) => m.sizeUK === null || args.userSizeUK === null || Math.abs(m.sizeUK - args.userSizeUK) < 0.01)
    .filter((m) => detectPlatform(m.url) === args.platform && !!httpsOnly(m.url))
    .sort((a, b) => a.priceGBP - b.priceGBP || a.id.localeCompare(b.id))
    .slice(0, MAX_SUGGESTIONS)
    .map((m) => ({
      id: m.id,
      title: m.title,
      priceGBP: m.priceGBP,
      url: m.url,
      ...(httpsOnly(m.thumbnailUrl) ? { thumbnailUrl: m.thumbnailUrl } : {}),
      platform: args.platform,
      sizeLabel: m.sizeLabel,
      sizeNotStated: m.sizeLabel === null,
      sponsored: m.sponsored,
      savingGBP: round2(args.price - m.priceGBP),
    }));
}

/** "14 Nov" */
export function surveyDate(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/** Evidence label: "Compared with 12 listings from your search on 14 Nov". */
export function observedEvidenceLabel(stats: SampleStats, surveyedOn: string): string {
  return `Compared with ${stats.n} listings from your search on ${surveyDate(surveyedOn)}`;
}

export function baseComparison(survey: Survey, matched: MatchedListing[]): Omit<ObservedComparison, "source" | "stats" | "context" | "note" | "suggestions"> {
  return {
    searchQuery: survey.searchQuery,
    surveyedOn: survey.surveyedOn,
    platform: survey.platform,
    priceBasis: survey.priceBasis,
    counts: { ...levelCounts(survey, matched), surveyed: survey.surveyed, auctionsExcluded: survey.auctionsExcluded, unpricedExcluded: survey.unpricedExcluded },
  };
}

/** Brand only: no comparison at all. */
export function modelUnknownComparison(survey: Survey): ObservedComparison {
  return { ...baseComparison(survey, matchSurvey(survey, null, undefined)), source: "none", stats: null, context: null, note: MODEL_UNKNOWN_NOTE, suggestions: [] };
}

/** Version unclear: family-level context only (not used for the verdict). */
export function familyComparison(survey: Survey, matched: MatchedListing[]): ObservedComparison {
  const context = observedContext(matched, { familyLevel: true });
  return { ...baseComparison(survey, matched), source: "none", stats: null, context, note: null, suggestions: [] };
}

// ---------- "Worth looking at": cheaper alternatives from the survey ----------

/** Most alternatives kept with the case (the panel shows 3, then "Show all"). */
export const MAX_ALTERNATIVES = 20;

export const noAlternatives = (survey: Pick<Survey, "platform" | "surveyedOn"> | null | undefined): ObservedAlternatives =>
  survey ? { surveyUsed: true, platform: survey.platform, surveyedOn: survey.surveyedOn, alternatives: [] } : { surveyUsed: false, platform: null, surveyedOn: null, alternatives: [] };

/**
 * The two prices to compare, on the same basis: what the buyer pays (buyer protection and postage included) when both
 * the card and the listing give it, otherwise the listed prices (postage not included). Surveyed cards only carry the
 * item price today, so in practice that is listed price against listed price.
 */
export function comparedPrices(
  card: Pick<SurveyListing, "priceGBP" | "totalGBP">,
  listing: Pick<ListingFacts, "priceGBP" | "totalGBP" | "totalIncludes">,
): { basis: ObservedAlternative["priceBasis"]; card: number; listing: number } | null {
  if (listing.priceGBP === undefined) return null;
  const listingTotal = listing.totalGBP !== undefined && listing.totalIncludes?.includes("buyer_protection") && listing.totalIncludes.includes("postage");
  if (card.totalGBP !== undefined && listingTotal) return { basis: "total", card: card.totalGBP, listing: listing.totalGBP! };
  return { basis: "listed", card: card.priceGBP, listing: listing.priceGBP };
}

export type AlternativeCandidate = MatchedListing & { compared: NonNullable<ReturnType<typeof comparedPrices>> };

const LEVEL_ORDER = { exact: 0, version_unknown: 1 } as const;

/**
 * Surveyed listings that could be alternatives, before the colour check: exact or version-not-stated matches, in the
 * user's size or stating no size (any adult size when the user's size isn't known), same platform with an https link,
 * and cheaper by at least 10% or £5 (whichever is larger) on the same price basis. Auctions and the listing being
 * investigated never reach here (prepareSurvey). Exact before version-not-stated, then cheapest first.
 */
export function alternativeCandidates(
  matched: MatchedListing[],
  args: { listing: Pick<ListingFacts, "priceGBP" | "totalGBP" | "totalIncludes">; userSizeUK: number | null; platform: Platform },
): AlternativeCandidate[] {
  const inSize = (m: MatchedListing) => {
    if (m.sizeLabel === null) return true; // "Size not stated"
    if (args.userSizeUK === null) return isAdult(m);
    return m.sizeUK !== null && Math.abs(m.sizeUK - args.userSizeUK) < 0.01; // a size that couldn't be converted can't be checked
  };
  const out: AlternativeCandidate[] = [];
  for (const m of matched) {
    if (m.level !== "exact" && m.level !== "version_unknown") continue;
    if (!inSize(m) || detectPlatform(m.url) !== args.platform || !httpsOnly(m.url)) continue;
    const compared = comparedPrices(m, args.listing);
    if (!compared || compared.listing - compared.card < minSaving(compared.listing) - 1e-9) continue;
    out.push({ ...m, compared });
  }
  return out.sort(
    (a, b) =>
      LEVEL_ORDER[a.level as keyof typeof LEVEL_ORDER] - LEVEL_ORDER[b.level as keyof typeof LEVEL_ORDER] ||
      a.compared.card - b.compared.card ||
      a.id.localeCompare(b.id),
  );
}

/** Candidates with their colour checked, as stored and sent: a different colour is left out, an unclear one is kept. */
export function toAlternatives(
  candidates: (AlternativeCandidate & { colourMatch?: "same" | "different" | "unknown" })[],
  survey: Pick<Survey, "platform" | "surveyedOn">,
): ObservedAlternatives {
  const alternatives = candidates
    .filter((c) => c.colourMatch !== "different")
    .slice(0, MAX_ALTERNATIVES)
    .map(
      (c): ObservedAlternative => ({
        listingId: c.id,
        title: c.title,
        priceGBP: c.compared.card,
        priceBasis: c.compared.basis,
        platform: survey.platform,
        url: c.url,
        ...(httpsOnly(c.thumbnailUrl) ? { thumbnailUrl: c.thumbnailUrl } : {}),
        size: c.sizeLabel,
        matchLevel: c.level as ObservedAlternative["matchLevel"],
        colourMatch: c.colourMatch === "same" ? "same" : "unknown",
        differenceGBP: round2(c.compared.card - c.compared.listing),
        observedOn: c.seenOn ?? survey.surveyedOn,
      }),
    );
  return { ...noAlternatives(survey), alternatives };
}
