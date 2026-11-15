import type { ConfidenceLevel, IdentifyResult, ListingFacts } from "@/schemas/domain";
import type { CatalogueModel } from "@/schemas/seed";
import { titleMatchesModel } from "@/lib/newPrices";
import { fullModelName } from "@/lib/identifyLabel";

/** Confidence at or above which a model with nothing conflicting is "likely". */
export const LIKELY_MIN = 0.75;
/** Confidence at or above which the model is "possible"; below it is a "best_guess". */
export const POSSIBLE_MIN = 0.5;

export type LevelInput = {
  confidence: number;
  /** Gemini suggested a model (brand-only is always best_guess). */
  hasModel: boolean;
  /** A style code was read clearly (backed by a quote or photo region, see extract.ts). */
  styleCodeRead: boolean;
  /** The listing's own title/details name the exact model and version. */
  listingNamesModel: boolean;
  /** The photos, or something else in the listing, point to a different model. */
  conflicting: boolean;
  /** Gemini Flash and the Pro recheck disagreed. */
  proDisagrees: boolean;
};

/** Never returns user_confirmed: only the confirm-identity endpoint sets that. */
export function assignLevel(i: LevelInput): Exclude<ConfidenceLevel, "user_confirmed"> {
  if (!i.hasModel) return "best_guess";
  if (i.proDisagrees) return "possible";
  if (i.conflicting) return i.confidence >= POSSIBLE_MIN ? "possible" : "best_guess";
  if (i.confidence >= LIKELY_MIN) return i.styleCodeRead || i.listingNamesModel ? "confirmed" : "likely";
  if (i.confidence >= POSSIBLE_MIN) return "possible";
  return "best_guess";
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Do the photos point to a different model than the one named? */
function photosConflict(result: IdentifyResult): boolean {
  const p = result.photoModel;
  const m = result.modelName;
  if (!p || !m || p.confidence < POSSIBLE_MIN) return false;
  const a = norm(p.modelName);
  const b = norm(m);
  return !(a === b || a.includes(b) || b.includes(a));
}

/**
 * The best guess and level for a result, once the listing's facts are known. Keeps Flash/Pro disagreement
 * (`proDisagrees`) and a user's confirmation as they are.
 */
export function withLevel(
  result: IdentifyResult,
  args: { facts: ListingFacts; pageText: string; catalogue: CatalogueModel[]; proDisagrees?: boolean },
): IdentifyResult {
  if (result.confidenceLevel === "user_confirmed") return result;
  const cat = result.catalogueModelId ? args.catalogue.find((m) => m.id === result.catalogueModelId) : undefined;
  const name = fullModelName(result.modelName, result.bestGuess?.version);
  const listingText = [args.facts.title, args.facts.modelText].filter(Boolean).join("\n");
  const names = name ? [name, ...(cat ? [cat.name, ...cat.aliases] : [])] : [];
  // The page text also holds "similar items" etc., so only the listing's own title and model field count as it naming the model.
  const listingNamesModel = names.some((n) => titleMatchesModel(listingText, "", n));
  const confidenceLevel = assignLevel({
    confidence: result.confidence,
    hasModel: !!name,
    styleCodeRead: !!args.facts.styleCode,
    listingNamesModel,
    conflicting: photosConflict(result),
    proDisagrees: args.proDisagrees ?? false,
  });
  return { ...withBestGuess(result), confidenceLevel };
}

/** Fill bestGuess from the flat fields when it is missing (cases stored before best guesses, or built by hand). */
function withBestGuess(result: IdentifyResult): IdentifyResult {
  if (result.bestGuess) return result;
  return {
    ...result,
    bestGuess: { brand: result.brand, model: result.modelName, version: null, colourway: null, confidence: result.confidence, evidence: result.evidence },
    alternatives: result.alternatives ?? [],
  };
}

/**
 * Old stored cases had no bestGuess, alternatives or level: derive them, so every reader sees the new shape.
 * Idempotent. Old family-tier cases (`versionUnclear`) become a "possible" best guess with the family and its options.
 */
export function normaliseIdentify(result: IdentifyResult | null | undefined): IdentifyResult | null {
  if (!result) return null;
  if (result.bestGuess && result.confidenceLevel) return { ...result, alternatives: result.alternatives ?? [], lensMatches: result.lensMatches ?? [] };
  const v = result.versionUnclear;
  const base: IdentifyResult = {
    ...result,
    alternatives: result.alternatives ?? [],
    lensMatches: result.lensMatches ?? [],
    bestGuess: result.bestGuess ?? { brand: result.brand, model: result.modelName, version: null, colourway: null, confidence: result.confidence, evidence: result.evidence },
  };
  if (result.confidenceLevel) return base;
  const alternatives = v?.options[1] && v.family ? [{ brand: result.brand, model: `${v.family} ${v.options[1]}`.trim(), version: null, colourway: null, confidence: Math.min(result.confidence, 0.5), evidence: [] }] : [];
  const level = v
    ? "possible"
    : assignLevel({
        confidence: result.confidence,
        hasModel: !!result.modelName,
        styleCodeRead: false,
        listingNamesModel: false,
        conflicting: photosConflict(result),
        proDisagrees: false,
      });
  return { ...base, ...(v && alternatives.length ? { alternatives } : {}), confidenceLevel: level };
}
