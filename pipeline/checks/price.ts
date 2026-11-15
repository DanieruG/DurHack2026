import type {
  ObservedComparison,
  CheckResult,
  CheckStatus,
  ConditionGrade,
  Evidence,
  GeminiFeature,
  ListingFacts,
  NewOffers,
  PricePosition,
  SampleStats,
  UserNeeds,
} from "@/schemas/domain";
import type { PriceSample } from "@/schemas/seed";
import { sampleEvidenceLabel, sampleStats } from "@/lib/priceSample";
import { summariseOffers, toNewOffers, type NewPrices, type ShoppingOffer } from "@/lib/newPrices";
import { colourBasis } from "../offerColour";
import {
  baseComparison,
  observedConfidence,
  observedContext,
  observedEvidenceLabel,
  observedStats,
  suggestCheaper,
  type MatchedListing,
  type Survey,
} from "@/lib/observed";
import { evidenceIds, gbp, round2, unknownCheck } from "../util";
import { totalWords } from "../listingData";

/**
 * What the buyer pays, for comparing with the new price: Vinted's total including buyer protection and postage, or eBay's
 * price plus postage when the page data gives it. `line` says so ("£31.18 including protection and postage"), or
 * "Postage not included" when the postage isn't known.
 */
export function listingTotal(facts: ListingFacts): { total: number; line: string | null; includes: ("buyer_protection" | "postage")[] } | null {
  const price = facts.priceGBP;
  if (price === undefined) return null;
  if (facts.totalGBP !== undefined && facts.totalIncludes?.length) {
    return { total: facts.totalGBP, line: `${gbp(facts.totalGBP)} ${totalWords(facts.totalIncludes)}`, includes: facts.totalIncludes };
  }
  return { total: price, line: facts.platform === "ebay" || facts.platform === "vinted" ? "Postage not included" : null, includes: [] };
}

export const SAMPLE_CONFIDENCE_CAP = 0.7;
/** New price only (no sample): 0.7 with 5+ retailer offers, 0.6 with 3-4. */
export const NEW_PRICE_CONFIDENCE = { many: 0.7, few: 0.6, manyFrom: 5 } as const;
/** Cap when the model isn't in the catalogue (no sample exists at all). */
export const NOT_IN_CATALOGUE_CONFIDENCE_CAP = 0.45;
export const NOT_IN_SAMPLE_NOTE = "This model isn't in our price sample, so price is compared with the current new price only.";
export const NO_NEW_PRICE = "I couldn't find enough current UK retailer prices for this model.";

/** The model being priced. `id` is the catalogue id, or null when the model isn't in the catalogue. */
export type PricedModel = { id: string | null; brand: string; name: string };

/** Source B: current new price = median of at least 3 UK retailer offers from Google Shopping (lib/newPrices.ts). */
export type NewPrice = {
  gbp: number;
  lowestGBP: number;
  offers: ShoppingOffer[];
  observedOn: string;
  /** Same-colour offers only (3 or more), or every matching-model offer ("Colours vary"). */
  colourBasis?: "same_colour" | "all_colours";
};

export function toNewPrice(r: NewPrices, basis?: "same_colour" | "all_colours"): NewPrice | null {
  return r.available && r.medianGBP !== null && r.lowestGBP !== null
    ? { gbp: r.medianGBP, lowestGBP: r.lowestGBP, offers: r.offers, observedOn: r.checkedOn, ...(basis ? { colourBasis: basis } : {}) }
    : null;
}

const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "New price £75, median of 4 UK retailers, checked 14 Nov" */
export function newPriceLabel(n: NewPrice): string {
  const colour = n.colourBasis === "same_colour" ? " in the same colour" : n.colourBasis === "all_colours" ? " (colours vary: includes other colourways)" : "";
  return `New price ${gbp(n.gbp)}, median of ${n.offers.length} UK retailers${colour}, checked ${shortDate(n.observedOn)}`;
}

// ---------- status table (pure) ----------

export type PriceDecision = { status: CheckStatus; position: PricePosition | null; overBudget: boolean };

/** Spec 7.6 status table, evaluated in order. */
export function decidePrice(args: {
  price: number;
  sample: SampleStats | null;
  newPrice: { gbp: number } | null;
  budgetGBP?: number;
  /** What the buyer pays (price plus known fees and postage), compared with the new price. Defaults to `price`. */
  totalPrice?: number;
}): PriceDecision {
  const { price, sample, newPrice } = args;
  const total = args.totalPrice ?? price;
  let status: CheckStatus;
  let position: PricePosition | null;
  if (!sample && !newPrice) {
    status = "unknown";
    position = null;
  } else if (newPrice && total >= newPrice.gbp) {
    status = "fail";
    position = "at_or_above_new";
  } else if (sample && price > sample.p90) {
    status = "fail";
    position = "above";
  } else if (sample && price < sample.p10) {
    status = "warn";
    position = "suspiciously_low";
  } else if ((sample && price <= sample.p25) || (!sample && newPrice && total <= 0.6 * newPrice.gbp)) {
    status = "pass";
    position = "below";
  } else {
    status = "pass";
    position = "typical";
  }
  const overBudget = args.budgetGBP !== undefined && price > args.budgetGBP;
  if (overBudget && status === "pass") status = "warn";
  return { status, position, overBudget };
}

// ---------- the check ----------

/** Run Source B? Always when A is unavailable; otherwise only when the price is high enough that "as much as new" is plausible. */
export function shouldRunSourceB(price: number, sample: SampleStats | null): boolean {
  return !sample || price >= sample.p75;
}

export type PriceCheckArgs = {
  facts: ListingFacts;
  needs: UserNeeds;
  model: PricedModel;
  samples: PriceSample[];
  /** Google Shopping lookup for this model (memoised per case). Called directly, never left to the model. */
  lookupNewPrices: () => Promise<NewPrices>;
  /** True when Gemini called the getNewPrices tool for this model (tags function_calling). */
  calledViaTool?: () => boolean;
  /** deeper_price_comparison lead: restrict Source A to this grade and force Source B. */
  condition?: ConditionGrade;
  forceSourceB?: boolean;
  /** Marks each offer's colour match against the listing's colour (title words, else thumbnail). */
  assessOfferColours?: (offers: ShoppingOffer[]) => Promise<ShoppingOffer[]>;
  /** Called as soon as the Shopping lookup returns (live or cached), before the check finishes: the new_offers event. */
  onNewOffers?: (offers: NewOffers) => void;
  /** The user's survey of a search on this platform, matched to this model (Source C). */
  observed?: { survey: Survey; matched: MatchedListing[]; userSizeUK: number | null };
};

export async function checkPrice(args: PriceCheckArgs): Promise<CheckResult> {
  const price = args.facts.priceGBP;
  const priceEv = args.facts.evidence.filter((e) => e.label.startsWith("Asking price"));
  if (price === undefined) {
    return unknownCheck("price", "The listing doesn't show a clear price in GBP, so I can't compare it.", {
      details: { position: null },
    });
  }
  const modelId = args.model.id;
  const inCatalogue = modelId !== null;
  // Source C (the user's own search) when it has 5+ exact matches; otherwise the catalogue sample (A), which needs a
  // catalogue match. The new-price rules (B) apply on top of either.
  const obs = args.observed;
  const observed = obs ? observedStats(obs.matched, obs.survey.surveyedOn) : null;
  const restricted = !observed && inCatalogue && args.condition ? sampleStats(args.samples, modelId, args.condition) : null;
  const sample = observed ?? restricted ?? (inCatalogue ? sampleStats(args.samples, modelId) : null);
  const usedGrade = restricted ? args.condition : undefined;
  const context = obs && !observed ? observedContext(obs.matched, { familyLevel: false }) : null;

  const paid = listingTotal(args.facts)!;
  const totalPrice = paid.total;
  let newPrice: NewPrice | null = null;
  let ranB = false;
  let offersSeen = 0;
  let shoppingLive: boolean | undefined;
  let newOffers: NewOffers | undefined;
  // Asking prices from one search can sit above the new price, so with Source C the new-price rules always run.
  if (args.forceSourceB || observed || shouldRunSourceB(price, sample)) {
    ranB = true;
    try {
      const looked = await args.lookupNewPrices();
      offersSeen = looked.offers.length;
      shoppingLive = !looked.fromCache;
      const coloured = args.assessOfferColours ? await args.assessOfferColours(looked.offers).catch(() => looked.offers) : looked.offers;
      const r = { ...looked, offers: coloured };
      // The new-price figure: same-colour offers when there are at least 3, otherwise all ("Colours vary").
      const basis = args.assessOfferColours ? colourBasis(coloured) : null;
      newOffers = toNewOffers(r, totalPrice, { colourNote: basis?.note });
      args.onNewOffers?.(newOffers);
      const priced = basis ? summariseOffers(basis.offers, { checkedOn: r.checkedOn, query: r.query, rawResults: r.rawResults }) : r;
      newPrice = toNewPrice(priced, basis?.basis);
    } catch (err) {
      if ((err as Error)?.name === "StageTimeoutError") throw err;
      newPrice = null;
    }
  }

  const decision = decidePrice({ price, sample, newPrice, budgetGBP: args.needs.budgetGBP, totalPrice });
  const nextId = evidenceIds("price");
  const evidence: Evidence[] = [...priceEv];
  const sampleLabel = sample ? (observed ? observedEvidenceLabel(observed, obs!.survey.surveyedOn) : sampleEvidenceLabel(sample)) : "";
  if (sample) {
    evidence.push({
      id: nextId(),
      kind: "data_point",
      label: sampleLabel + (usedGrade ? ` (${usedGrade.replace(/_/g, " ")} only)` : ""),
      value: `median ${gbp(sample.median)}; middle half ${gbp(sample.p25)}–${gbp(sample.p75)}; ${sample.excluded} outlier(s) excluded`,
      sourceType: observed ? "observed_listings" : "price_sample",
      observedOn: sample.collectedOn.to,
    });
  }
  if (context) {
    evidence.push({ id: nextId(), kind: "data_point", label: `${context.line} (not enough exact matches to compare)`, sourceType: "observed_listings", observedOn: obs!.survey.surveyedOn });
  }
  if (newPrice) {
    evidence.push({ id: nextId(), kind: "data_point", label: newPriceLabel(newPrice), value: newPrice.gbp, sourceType: "retailer", observedOn: newPrice.observedOn });
    for (const o of newPrice.offers) {
      evidence.push({ id: nextId(), kind: "source", label: `Retailer: ${o.retailer}, ${gbp(o.priceGBP)}`, value: o.priceGBP, url: o.url, title: o.title, sourceType: "retailer", observedOn: newPrice.observedOn });
    }
  }

  const body = decision.position === null ? NO_NEW_PRICE : priceSummary({ price, sample, sampleLabel, newPrice, decision, grade: usedGrade, paid });
  const withContext = context ? `${body} ${context.line} in your search.` : body;
  const summary = inCatalogue || observed ? withContext : `${NOT_IN_SAMPLE_NOTE} ${withContext}`;
  const features: GeminiFeature[] = args.calledViaTool?.() ? ["function_calling"] : [];

  const newPriceConfidence = newPrice ? (newPrice.offers.length >= NEW_PRICE_CONFIDENCE.manyFrom ? NEW_PRICE_CONFIDENCE.many : NEW_PRICE_CONFIDENCE.few) : 0;
  const base =
    decision.status === "unknown"
      ? 0
      : observed
        ? observedConfidence(observed)
        : sample
          ? Math.min(SAMPLE_CONFIDENCE_CAP, round2(0.4 + sample.n * 0.02))
          : newPriceConfidence;
  const confidence = inCatalogue || observed ? base : Math.min(base, NOT_IN_CATALOGUE_CONFIDENCE_CAP);

  const observedComparison: ObservedComparison | undefined = obs
    ? {
        ...baseComparison(obs.survey, obs.matched),
        source: observed ? "observed_listings" : sample ? "price_sample" : newPrice ? "new_price" : "none",
        stats: observed ? { n: observed.n, excluded: observed.excluded, median: observed.median, p10: observed.p10, p25: observed.p25, p75: observed.p75, p90: observed.p90 } : null,
        context,
        note: null,
        suggestions: suggestCheaper(obs.matched, { price, userSizeUK: obs.userSizeUK, platform: obs.survey.platform }),
      }
    : undefined;

  return {
    check: "price",
    status: decision.status,
    summary,
    evidence,
    confidence,
    geminiFeatures: features,
    details: {
      listingPriceGBP: price,
      listingTotalGBP: totalPrice,
      ...(paid.line ? { priceBasis: paid.line } : {}),
      ...(sample ? { sample } : {}),
      ...(newPrice ? { newPrice: { gbp: newPrice.gbp, lowestGBP: newPrice.lowestGBP, sources: newPrice.offers.length, observedOn: newPrice.observedOn, ...(newPrice.colourBasis ? { colourBasis: newPrice.colourBasis } : {}) } } : {}),
      position: decision.position,
      overBudget: decision.overBudget,
      budgetGBP: args.needs.budgetGBP,
      conditionGrade: usedGrade ?? null,
      sourceBRun: ranB,
      retailerOffers: offersSeen,
      // Unknown only because the Shopping lookup failed or found too few retailers.
      searchFailed: decision.status === "unknown" && ranB && !newPrice,
      ...(shoppingLive !== undefined ? { shoppingLive } : {}),
      ...(newOffers ? { newOffers } : {}),
      ...(observedComparison ? { observedComparison } : {}),
      inCatalogue,
    },
  };
}

function priceSummary(a: {
  price: number;
  sample: SampleStats | null;
  /** The comparison's evidence label ("Compared with 12 listings sampled on 10 Nov" / "... from your search on 14 Nov"). */
  sampleLabel: string;
  newPrice: NewPrice | null;
  decision: PriceDecision;
  grade?: ConditionGrade;
  /** What the buyer pays, for the new-price comparisons. */
  paid?: { total: number; line: string | null; includes: string[] };
}): string {
  const p = gbp(a.price);
  // New-price comparisons use what the buyer pays and say so ("£31.18 including protection and postage").
  const pNew = a.paid?.line ? (a.paid.includes.length ? a.paid.line : `${p} (${a.paid.line.toLowerCase()})`) : p;
  const sampled = a.sample ? a.sampleLabel.replace(/^Compared with/, "compared with") : "";
  const colourBit = a.newPrice?.colourBasis === "same_colour" ? " in the same colour" : "";
  const varyBit = a.newPrice?.colourBasis === "all_colours" ? "; colours vary, so this includes other colourways" : "";
  const newBit = a.newPrice ? `new it's about ${gbp(a.newPrice.gbp)} (median of ${a.newPrice.offers.length} UK retailers${colourBit}, checked ${shortDate(a.newPrice.observedOn)}${varyBit})` : "";
  let s: string;
  switch (a.decision.position) {
    case null:
      return NO_NEW_PRICE;
    case "at_or_above_new":
      s = `At ${pNew} it costs as much as buying new: ${newBit}.`;
      break;
    case "above":
      s = `At ${p} it's well above ${/your search/.test(a.sampleLabel) ? "the listings in your search" : "the sampled listings"} (${sampled}, median ${gbp(a.sample!.median)}).`;
      break;
    case "suspiciously_low":
      s = `At ${p} it's unusually low (${sampled}, median ${gbp(a.sample!.median)}); check condition and details.`;
      break;
    case "below":
      s = a.sample
        ? `At ${p} it's below most comparable listings (${sampled}, median ${gbp(a.sample.median)}).`
        : `At ${pNew} it's well under the new price: ${newBit}.`;
      break;
    default:
      s = a.sample
        ? `At ${p} it's a typical price (${sampled}, median ${gbp(a.sample.median)}).`
        : `At ${pNew} it's under the new price but not a bargain: ${newBit}.`;
  }
  if (a.decision.overBudget) s += " It's over your budget.";
  return s;
}
