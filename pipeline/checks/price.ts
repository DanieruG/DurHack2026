import type {
  CheckResult,
  CheckStatus,
  ConditionGrade,
  Evidence,
  GeminiFeature,
  ListingFacts,
  PricePosition,
  SampleStats,
  UserNeeds,
} from "@/schemas/domain";
import type { PriceSample } from "@/schemas/seed";
import { sampleEvidenceLabel, sampleStats } from "@/lib/priceSample";
import type { GeminiClient } from "@/gemini/client";
import { z } from "zod";
import { sourceToEvidence, type GroundedSource } from "@/gemini/grounding";
import { groundedSearch, segmentList, type Segment } from "@/gemini/groundedSearch";
import { generateStructured } from "@/gemini/structured";
import type { ToolExecutor } from "@/gemini/tools";
import { evidenceIds, gbp, round2, unknownCheck, withSearchBudget } from "../util";

export const SAMPLE_CONFIDENCE_CAP = 0.7;
/** New price only, for a catalogue model whose sample is missing. */
export const NEW_PRICE_ONLY_CONFIDENCE = 0.6;
/** New price only because the model isn't in the catalogue (no sample exists at all). */
export const NOT_IN_CATALOGUE_CONFIDENCE_CAP = 0.45;
export const NOT_IN_SAMPLE_NOTE = "This model isn't in our price sample, so price is compared with the current new price only.";
export const NEW_PRICE_AGREEMENT = 0.15;

// Resale / second-hand marketplaces: never used as a "new price" source.
const RESALE = /(^|\.)(ebay|vinted|depop|facebook|gumtree|preloved|stockx|goat|laced|klekt|grailed|poshmark|mercari|vestiairecollective|thredup|shpock|alias)\./i;

/** The model being priced. `id` is the catalogue id, or null when the model isn't in the catalogue. */
export type PricedModel = { id: string | null; brand: string; name: string };

export type NewPrice = {
  gbp: number;
  sources: { domain: string; title: string; url: string; priceGBP: number; line: string; chunk: GroundedSource }[];
  observedOn: string;
  calledFunctions: string[];
};

// ---------- Source B: current new price via Google Search grounding ----------

/** Step 1 (grounded): plain prose, which keeps Google's source attribution (a rigid line format loses it). */
export function newPricePrompt(model: Pick<PricedModel, "brand" | "name">): string {
  return (
    `What does a brand-new pair of ${model.brand} ${model.name} trainers (adult sizes, standard colourways) cost right now ` +
    `from UK retailers and ${model.brand}'s UK site? Search for current prices and write one short sentence per retailer, ` +
    `naming the retailer and the price in GBP. Only brand-new pairs: leave out second-hand, used, pre-owned and resale ` +
    `prices (eBay, Vinted, Depop, StockX, GOAT and similar).`
  );
}

export const PriceItemsSchema = z.object({
  prices: z
    .array(
      z.object({
        segment: z.string(),
        retailer: z.string(),
        priceGBP: z.number(),
        brandNew: z.boolean(),
      }),
    )
    .default([]),
});
export type PriceItem = z.infer<typeof PriceItemsSchema>["prices"][number];

const PRICE_PARSE_SYSTEM = `You turn search-answer sentences into data. Each sentence has an id (S1, S2, ...).
For every sentence that states the price of a pair at a retailer or the brand's own site, return one item:
segment (the sentence id), retailer (as written), priceGBP (the number written in that sentence, in GBP), brandNew
(false for second-hand, used, pre-owned, resale or marketplace prices). Use only what the sentence says; never add prices.`;

/** Step 2 (no tools): structure the supported sentences. */
export async function structurePrices(gemini: GeminiClient, segments: Segment[]): Promise<PriceItem[]> {
  const { data } = await generateStructured(gemini, PriceItemsSchema, {
    stage: "price_parse",
    tier: "fast",
    system: PRICE_PARSE_SYSTEM,
    parts: [{ text: segmentList(segments) }],
    temperature: 0,
    thinking: "LOW",
  });
  return data.prices;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** True if the sentence itself contains this price (guards against the structuring step inventing numbers). */
export function sentenceHasPrice(text: string, price: number): boolean {
  for (const m of text.matchAll(/£\s?(\d{1,4}(?:,\d{3})*(?:\.\d{1,2})?)|(\d{1,4}(?:\.\d{1,2})?)\s?(?:GBP|pounds)/gi)) {
    const n = Number((m[1] ?? m[2]).replace(/,/g, ""));
    if (Math.abs(n - price) < 0.005) return true;
  }
  return false;
}

/**
 * Attribute each structured price only to sources that Google says support its sentence; prefer the source whose
 * domain matches the named retailer. Drops resale sites, review sites, invented prices and repeat domains.
 */
export function pricesFromSegments(items: PriceItem[], segments: Segment[]): NewPrice["sources"] {
  const out: NewPrice["sources"] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const seg = segments.find((s) => s.id === item.segment.trim().toUpperCase());
    if (!seg || !item.brandNew) continue;
    const priceGBP = item.priceGBP;
    if (!(priceGBP > 5 && priceGBP < 2000) || !sentenceHasPrice(seg.text, priceGBP)) continue;
    const eligible = seg.sources.filter((src) => !RESALE.test(src.domain + ".") && src.sourceType !== "independent_review");
    const want = norm(item.retailer);
    const named = want.length >= 3 ? eligible.filter((src) => norm(src.domain).includes(want) || want.includes(norm(src.domain.split(".")[0]))) : [];
    for (const src of named.length ? named : eligible) {
      if (seen.has(src.domain)) continue;
      seen.add(src.domain);
      out.push({ domain: src.domain, title: src.title, url: src.url, priceGBP, line: seg.text, chunk: src });
      break; // one source per price item
    }
  }
  return out;
}

/** Accept only if >= 2 distinct sources agree within 15%; the new price is the median of the agreeing cluster. */
export function agreeingCluster(prices: { priceGBP: number }[], tolerance = NEW_PRICE_AGREEMENT): number[] | null {
  const sorted = prices.map((p, i) => ({ v: p.priceGBP, i })).sort((a, b) => a.v - b.v);
  let best: { v: number; i: number }[] = [];
  for (let start = 0; start < sorted.length; start++) {
    const window = sorted.filter((x) => x.v >= sorted[start].v && x.v <= sorted[start].v * (1 + tolerance));
    if (window.length > best.length) best = window;
  }
  return best.length >= 2 ? best.map((x) => x.i) : null;
}

export async function findNewPrice(
  gemini: GeminiClient,
  args: { model: Pick<PricedModel, "brand" | "name">; today: string; combinedTools: boolean; executors: Partial<Record<string, ToolExecutor>> },
): Promise<NewPrice | null> {
  const answer = await groundedSearch(gemini, {
    stage: "price",
    prompt: newPricePrompt(args.model),
    combinedTools: args.combinedTools,
    functions: ["sampleStats"],
    executors: args.executors,
  });
  const found = pricesFromSegments(await structurePrices(gemini, answer.segments), answer.segments);
  const cluster = agreeingCluster(found);
  if (!cluster) return null;
  const agreeing = cluster.map((i) => found[i]);
  const prices = agreeing.map((a) => a.priceGBP).sort((a, b) => a - b);
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 ? prices[mid] : round2((prices[mid - 1] + prices[mid]) / 2);
  return { gbp: median, sources: agreeing, observedOn: args.today, calledFunctions: answer.calledFunctions };
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
  today: string;
  gemini: GeminiClient;
  combinedTools: boolean;
  executors: Partial<Record<string, ToolExecutor>>;
  /** deeper_price_comparison lead: restrict Source A to this grade and force Source B. */
  condition?: ConditionGrade;
  forceSourceB?: boolean;
  /** Reuse a previous Source B result instead of calling again. */
  previousNewPrice?: NewPrice | null;
  /** SEARCH_TIMEOUT_MS: past this, Source B is skipped and the sample alone decides. */
  searchTimeoutMs?: number;
};

export async function checkPrice(args: PriceCheckArgs): Promise<CheckResult & { newPrice?: NewPrice | null }> {
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

  let newPrice: NewPrice | null = args.previousNewPrice ?? null;
  let ranB = !!newPrice;
  let bError = false;
  if (!newPrice && (args.forceSourceB || shouldRunSourceB(price, sample))) {
    ranB = true;
    try {
      newPrice = await withSearchBudget(args.searchTimeoutMs, () =>
        findNewPrice(args.gemini, { model: args.model, today: args.today, combinedTools: args.combinedTools, executors: args.executors }),
      );
    } catch (err) {
      if ((err as Error)?.name === "StageTimeoutError") throw err;
      bError = true;
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
    for (const s of newPrice.sources) {
      evidence.push({ ...sourceToEvidence(s.chunk, nextId(), newPrice.observedOn, s.line), label: `New price at ${s.title}: ${gbp(s.priceGBP)}`, value: s.priceGBP, sourceType: s.chunk.sourceType === "manufacturer" ? "manufacturer" : "retailer" });
    }
  }

  const summary = inCatalogue
    ? priceSummary({ price, sample, newPrice, decision, grade: usedGrade })
    : `${NOT_IN_SAMPLE_NOTE} ${decision.position === null ? "I couldn't find a reliable current new price, so the price is unknown." : priceSummary({ price, sample, newPrice, decision })}`;
  const features: GeminiFeature[] = [];
  if (ranB && !bError) features.push("search_grounding");
  if (newPrice?.calledFunctions.length) features.push("function_calling");

  const confidence =
    decision.status === "unknown"
      ? 0
      : sample
        ? Math.min(SAMPLE_CONFIDENCE_CAP, round2(0.4 + sample.n * 0.02))
        : inCatalogue
          ? NEW_PRICE_ONLY_CONFIDENCE
          : NOT_IN_CATALOGUE_CONFIDENCE_CAP;

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
      ...(newPrice ? { newPrice: { gbp: newPrice.gbp, sources: newPrice.sources.length, observedOn: newPrice.observedOn } } : {}),
      position: decision.position,
      overBudget: decision.overBudget,
      budgetGBP: args.needs.budgetGBP,
      conditionGrade: usedGrade ?? null,
      sourceBRun: ranB,
      inCatalogue,
    },
    newPrice,
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
  const newBit = a.newPrice ? `new it's about ${gbp(a.newPrice.gbp)} (${a.newPrice.sources.length} retailers, checked ${a.newPrice.observedOn})` : "";
  let s: string;
  switch (a.decision.position) {
    case null:
      return "I couldn't find reliable price comparisons for this model.";
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
