import type {
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
import { toNewOffers, type NewPrices, type ShoppingOffer } from "@/lib/newPrices";
import { evidenceIds, gbp, round2, unknownCheck } from "../util";

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
export type NewPrice = { gbp: number; lowestGBP: number; offers: ShoppingOffer[]; observedOn: string };

export function toNewPrice(r: NewPrices): NewPrice | null {
  return r.available && r.medianGBP !== null && r.lowestGBP !== null
    ? { gbp: r.medianGBP, lowestGBP: r.lowestGBP, offers: r.offers, observedOn: r.checkedOn }
    : null;
}

const shortDate = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** "New price £75, median of 4 UK retailers, checked 14 Nov" */
export function newPriceLabel(n: NewPrice): string {
  return `New price ${gbp(n.gbp)}, median of ${n.offers.length} UK retailers, checked ${shortDate(n.observedOn)}`;
}

// ---------- status table (pure) ----------

export type PriceDecision = { status: CheckStatus; position: PricePosition | null; overBudget: boolean };

/** Spec 7.6 status table, evaluated in order. */
export function decidePrice(args: {
  price: number;
  sample: SampleStats | null;
  newPrice: { gbp: number } | null;
  budgetGBP?: number;
}): PriceDecision {
  const { price, sample, newPrice } = args;
  let status: CheckStatus;
  let position: PricePosition | null;
  if (!sample && !newPrice) {
    status = "unknown";
    position = null;
  } else if (newPrice && price >= newPrice.gbp) {
    status = "fail";
    position = "at_or_above_new";
  } else if (sample && price > sample.p90) {
    status = "fail";
    position = "above";
  } else if (sample && price < sample.p10) {
    status = "warn";
    position = "suspiciously_low";
  } else if ((sample && price <= sample.p25) || (!sample && newPrice && price <= 0.6 * newPrice.gbp)) {
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
  /** Called as soon as the Shopping lookup returns (live or cached), before the check finishes: the new_offers event. */
  onNewOffers?: (offers: NewOffers) => void;
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
  // The sampled comparison needs a catalogue match; otherwise only the current new price (Source B) is available.
  const restricted = inCatalogue && args.condition ? sampleStats(args.samples, modelId, args.condition) : null;
  const sample = restricted ?? (inCatalogue ? sampleStats(args.samples, modelId) : null);
  const usedGrade = restricted ? args.condition : undefined;

  let newPrice: NewPrice | null = null;
  let ranB = false;
  let offersSeen = 0;
  let shoppingLive: boolean | undefined;
  let newOffers: NewOffers | undefined;
  if (args.forceSourceB || shouldRunSourceB(price, sample)) {
    ranB = true;
    try {
      const r = await args.lookupNewPrices();
      offersSeen = r.offers.length;
      shoppingLive = !r.fromCache;
      newOffers = toNewOffers(r, price);
      args.onNewOffers?.(newOffers);
      newPrice = toNewPrice(r);
    } catch (err) {
      if ((err as Error)?.name === "StageTimeoutError") throw err;
      newPrice = null;
    }
  }

  const decision = decidePrice({ price, sample, newPrice, budgetGBP: args.needs.budgetGBP });
  const nextId = evidenceIds("price");
  const evidence: Evidence[] = [...priceEv];
  if (sample) {
    evidence.push({
      id: nextId(),
      kind: "data_point",
      label: sampleEvidenceLabel(sample) + (usedGrade ? ` (${usedGrade.replace(/_/g, " ")} only)` : ""),
      value: `median ${gbp(sample.median)}; middle half ${gbp(sample.p25)}–${gbp(sample.p75)}; ${sample.excluded} outlier(s) excluded`,
      sourceType: "price_sample",
      observedOn: sample.collectedOn.to,
    });
  }
  if (newPrice) {
    evidence.push({ id: nextId(), kind: "data_point", label: newPriceLabel(newPrice), value: newPrice.gbp, sourceType: "retailer", observedOn: newPrice.observedOn });
    for (const o of newPrice.offers) {
      evidence.push({ id: nextId(), kind: "source", label: `Retailer: ${o.retailer}, ${gbp(o.priceGBP)}`, value: o.priceGBP, url: o.url, title: o.title, sourceType: "retailer", observedOn: newPrice.observedOn });
    }
  }

  const body = decision.position === null ? NO_NEW_PRICE : priceSummary({ price, sample, newPrice, decision, grade: usedGrade });
  const summary = inCatalogue ? body : `${NOT_IN_SAMPLE_NOTE} ${body}`;
  const features: GeminiFeature[] = args.calledViaTool?.() ? ["function_calling"] : [];

  const newPriceConfidence = newPrice ? (newPrice.offers.length >= NEW_PRICE_CONFIDENCE.manyFrom ? NEW_PRICE_CONFIDENCE.many : NEW_PRICE_CONFIDENCE.few) : 0;
  const base =
    decision.status === "unknown" ? 0 : sample ? Math.min(SAMPLE_CONFIDENCE_CAP, round2(0.4 + sample.n * 0.02)) : newPriceConfidence;
  const confidence = inCatalogue ? base : Math.min(base, NOT_IN_CATALOGUE_CONFIDENCE_CAP);

  return {
    check: "price",
    status: decision.status,
    summary,
    evidence,
    confidence,
    geminiFeatures: features,
    details: {
      listingPriceGBP: price,
      ...(sample ? { sample } : {}),
      ...(newPrice ? { newPrice: { gbp: newPrice.gbp, lowestGBP: newPrice.lowestGBP, sources: newPrice.offers.length, observedOn: newPrice.observedOn } } : {}),
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
      inCatalogue,
    },
  };
}

function priceSummary(a: {
  price: number;
  sample: SampleStats | null;
  newPrice: NewPrice | null;
  decision: PriceDecision;
  grade?: ConditionGrade;
}): string {
  const p = gbp(a.price);
  const sampled = a.sample ? `${sampleEvidenceLabel(a.sample).replace(/^Compared with/, "compared with")}` : "";
  const newBit = a.newPrice ? `new it's about ${gbp(a.newPrice.gbp)} (median of ${a.newPrice.offers.length} UK retailers, checked ${shortDate(a.newPrice.observedOn)})` : "";
  let s: string;
  switch (a.decision.position) {
    case null:
      return NO_NEW_PRICE;
    case "at_or_above_new":
      s = `At ${p} it costs as much as buying new: ${newBit}.`;
      break;
    case "above":
      s = `At ${p} it's well above the sampled listings (${sampled}, median ${gbp(a.sample!.median)}).`;
      break;
    case "suspiciously_low":
      s = `At ${p} it's unusually low (${sampled}, median ${gbp(a.sample!.median)}); check condition and details.`;
      break;
    case "below":
      s = a.sample
        ? `At ${p} it's below most comparable listings (${sampled}, median ${gbp(a.sample.median)}).`
        : `At ${p} it's well under the new price: ${newBit}.`;
      break;
    default:
      s = a.sample
        ? `At ${p} it's a typical price (${sampled}, median ${gbp(a.sample.median)}).`
        : `At ${p} it's under the new price but not a bargain: ${newBit}.`;
  }
  if (a.decision.overBudget) s += " It's over your budget.";
  return s;
}
