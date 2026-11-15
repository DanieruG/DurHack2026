import { z } from "zod";
import type { CheckResult, Evidence, GeminiFeature, IdentifyResult, ListingFacts } from "@/schemas/domain";
import type { CatalogueModel } from "@/schemas/seed";
import { getCatalogueCandidates, MAX_CANDIDATES } from "@/lib/catalogue";
import type { StoredImage } from "@/lib/images";
import { generateStructured } from "@/gemini/structured";
import { imagePart, type GeminiClient, type Part, type Tier } from "@/gemini/client";
import type { CaseImage } from "./intake";
import { clamp01, evidenceIds, textContains } from "./util";
import { titleMatchesModel } from "@/lib/newPrices";
import { candidateName, fullModelName, identifyLabel } from "@/lib/identifyLabel";
import { LIKELY_MIN, normaliseIdentify, withLevel } from "./identifyLevel";

export const IDENTIFY_SYSTEM = `You identify the trainers in a second-hand listing, sceptically, in tiers: brand, then model, then catalogue match.
- Use ONLY this listing's own title, item details, description and photos. Ignore everything about other listings on the page:
  "similar items", "sponsored", "you may also like", "explore related items", other sellers' items, ads, recently viewed.
  A model that is named only there is NOT evidence about this pair.
- brand: the brand of this pair (e.g. "adidas"), or null if you can't tell. brandConfidence: your probability (0-1) that it is right.
- modelName: the exact model without the brand (e.g. "Dropset 3", "Pegasus 40"), even when it is not one of the candidates.
  Null when this listing doesn't show it clearly. Tell similar models and versions (e.g. Pegasus 39 vs 40) apart by visible details
  or text; if you can't, return null.
- catalogueModelId: ONLY when the pair is exactly one of the candidate catalogue ids given; otherwise null. A wrong id is far worse than none.
- confidence: your probability (0-1) that modelName (and catalogueModelId, if set) is exactly right; 0 when modelName is null.
- version: the version or edition if the listing or photos show it (e.g. "Essential", "OG", "GTX"), else null. colourway: the colourway name if shown, else null.
- alternatives: up to 2 other models this pair could be, most likely first, each with its own confidence and a short reason. Always suggest
  at least one model when the brand is known, even a poor guess: say so in confidence. Leave modelName null only when you can't suggest any model at all,
  and then give noModelReason.
- photoModel: the model name the PHOTOS ALONE show, ignoring the title, description and candidate text; return null when the photos do not settle it, with confidence 0-1.
- evidence: what you relied on: kind "quote" with exact text from this listing, or kind "photo_region" with photoIndex and box2d
  [ymin, xmin, ymax, xmax] normalised 0-1000 (e.g. tongue label, logo, sole pattern).`;

/**
 * The user's marketplace search, sent as a hint (Feature A4). It says what the user was looking for, not what this pair
 * is: the listing's own title, details and photos decide. guardSearchHint enforces that in code.
 */
export function searchHintPart(searchQuery: string | null | undefined): Part[] {
  const q = searchQuery?.replace(/[\u0000-\u001f"“”]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!q) return [];
  return [
    {
      text:
        `HINT, the user's own search (NOT a fact about this listing): the user found this listing by searching "${q}".\n` +
        "Never identify the pair from this search: a search returns many different models. Use only this listing's own title, " +
        "details and photos. If they don't show the model clearly, leave modelName null even if the search names one, and " +
        "don't raise your confidence because the search agrees.",
    },
  ];
}

/** Cap for a model named only by the search hint: below "likely", so it can never become a confident identification. */
export const HINT_ONLY_MARGIN = 0.05;

/**
 * The search hint must never produce a confident identification on its own, and must not raise confidence when the
 * photos are unclear: if the model appears in the user's search but not in the listing's own text, and no photo region
 * supports it, its confidence is capped below "likely" (the brand still stands). A model read from a photo is
 * rechecked by Gemini Pro without the hint (versionCheck.ts), so the photos decide there.
 */
export function guardSearchHint(
  result: IdentifyResult,
  args: { searchQuery: string | null | undefined; listingText: string; catalogue: CatalogueModel[] },
): IdentifyResult {
  if (!args.searchQuery || !result.modelName) return result;
  const cat = result.catalogueModelId ? args.catalogue.find((m) => m.id === result.catalogueModelId) : undefined;
  const names = [result.modelName, ...(cat ? [cat.name, ...cat.aliases] : [])];
  const inListing = names.some((n) => titleMatchesModel(args.listingText, "", n));
  const inSearch = names.some((n) => titleMatchesModel(args.searchQuery!, "", n));
  if (inListing || !inSearch) return result;
  if (result.evidence.some((e) => e.kind === "photo_region")) return result;
  const cap = Math.max(0, LIKELY_MIN - HINT_ONLY_MARGIN);
  if (result.confidence <= cap) return result;
  return {
    ...result,
    confidence: cap,
    reasons: `${result.reasons} The model matches the user's search, but this listing's own text and photos don't show it, so it isn't relied on.`.trim(),
  };
}

/** Identification fields (shared by identify and the merged extract+identify call). */
export function identifyWireSchema(ids: string[]) {
  return z.object({
    brand: z.string().nullish(),
    brandConfidence: z.number().min(0).max(1).nullish(),
    modelName: z.string().nullish(),
    version: z.string().nullish(),
    colourway: z.string().nullish(),
    noModelReason: z.string().nullish(),
    alternatives: z
      .array(
        z.object({
          modelName: z.string().min(1),
          version: z.string().nullish(),
          colourway: z.string().nullish(),
          confidence: z.number().min(0).max(1),
          reason: z.string().nullish(),
        }),
      )
      .max(2)
      .default([]),
    catalogueModelId: (ids.length ? z.enum(ids as [string, ...string[]]) : z.string()).nullable(),
    confidence: z.number().min(0).max(1),
    reasons: z.string(),
    evidence: z
      .array(
        z.object({
          kind: z.enum(["quote", "photo_region"]),
          label: z.string(),
          quote: z.string().nullish(),
          photoIndex: z.number().int().nonnegative().nullish(),
          box2d: z.array(z.number()).length(4).nullish(),
        }),
      )
      .default([]),
    photoModel: z.object({ modelName: z.string().min(1), confidence: z.number().min(0).max(1) }).nullable().default(null),
  });
}

export type IdentifyTier = "catalogue" | "model" | "brand" | "none";

/** What the downstream checks run on: the best guess, whatever its confidence level. */
export type Subject = {
  tier: IdentifyTier;
  brand: string | null;
  /** Model name without the brand (with the version, when there is one). */
  modelName: string | null;
  /** "adidas Dropset 3", "adidas", or null. */
  displayName: string | null;
  catalogue: CatalogueModel | null;
};

const NO_SUBJECT: Subject = { tier: "none", brand: null, modelName: null, displayName: null, catalogue: null };

/**
 * There is no confidence gate: a named model is always the subject (its confidence level decides whether to pause for the
 * buyer, not whether to use it). Brand only when Gemini suggested no model; none when not even the brand is known.
 */
export function subjectOf(result: IdentifyResult | null | undefined, catalogue: CatalogueModel[]): Subject {
  if (!result) return NO_SUBJECT;
  const cat = result.catalogueModelId ? (catalogue.find((m) => m.id === result.catalogueModelId) ?? null) : null;
  const brand = cat?.brand ?? result.brand ?? null;
  const modelName = cat?.name ?? fullModelName(result.modelName, result.bestGuess?.version);
  if (!brand) return NO_SUBJECT;
  if (!modelName) {
    // Brand only: a weak brand guess isn't enough to say anything (verdict R1).
    return (result.brandConfidence ?? 0) >= POSSIBLE_BRAND_MIN ? { tier: "brand", brand, modelName: null, displayName: brand, catalogue: null } : NO_SUBJECT;
  }
  return { tier: cat ? "catalogue" : "model", brand, modelName, displayName: `${brand} ${modelName}`, catalogue: cat };
}

/** Brand-only needs at least this much confidence in the brand. */
const POSSIBLE_BRAND_MIN = 0.5;

/** Verdict rule R1 fires only when not even the brand is known. */
export function brandKnown(result: IdentifyResult | null | undefined, catalogue: CatalogueModel[]): boolean {
  return subjectOf(result, catalogue).tier !== "none";
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

/** Exact (normalised) brand + name/alias match against the catalogue, for when the model named a listed model but left the id null. */
function matchCatalogue(brand: string | null, modelName: string | null, catalogue: CatalogueModel[]): CatalogueModel | null {
  if (!brand || !modelName) return null;
  const want = norm(modelName);
  return catalogue.find((m) => norm(m.brand) === norm(brand) && [m.name, ...m.aliases].some((n) => norm(n) === want)) ?? null;
}

function cleanModelName(brand: string | null, modelName: string | null | undefined): string | null {
  let name = modelName?.replace(/\s+/g, " ").trim() ?? "";
  // "adidas Dropset 3" -> "Dropset 3"
  const words = name.split(" ");
  const n = brand ? brand.trim().split(/\s+/).length : 0;
  if (brand && words.length > n && norm(words.slice(0, n).join(" ")) === norm(brand)) name = words.slice(n).join(" ");
  return name && !/^(unknown|none|n\/a)$/i.test(name) ? name.slice(0, 80) : null;
}

export type IdentifyWire = z.infer<ReturnType<typeof identifyWireSchema>>;

/** Catalogue shortlist for a listing: by extracted brand/model/title, or by the page text when nothing is extracted yet. */
export function identifyShortlist(hay: { brandText?: string; modelText?: string; title?: string }, catalogue: CatalogueModel[]): CatalogueModel[] {
  const candidates = getCatalogueCandidates(hay, catalogue);
  return candidates.slice(0, Math.max(MAX_CANDIDATES, Math.min(candidates.length, 20)));
}

export function candidateList(shortlist: CatalogueModel[]): string {
  return `Candidate catalogue models (this pair may be none of them):\n${shortlist.map((m) => `- ${m.id}: ${m.brand} ${m.name} (aka ${m.aliases.join(", ") || "-"})`).join("\n")}`;
}

/** Reference images for the top candidates (when the catalogue has them). */
export async function referenceParts(shortlist: CatalogueModel[], read: (p: string) => Promise<StoredImage | null>): Promise<Part[]> {
  const refs = await Promise.all(shortlist.slice(0, MAX_CANDIDATES).map(async (m) => ({ m, img: m.referenceImg ? await read(m.referenceImg) : null })));
  return refs.flatMap((r) => (r.img ? [{ text: `Reference image for ${r.m.id}:` }, imagePart(r.img)] : []));
}

/** Map the wire identification to IdentifyResult: verify evidence, canonicalise brand, match the catalogue. */
export function toIdentifyResult(
  data: IdentifyWire,
  args: { shortlist: CatalogueModel[]; catalogue: CatalogueModel[]; pageText: string; photoCount: number },
): IdentifyResult {
  const nextId = evidenceIds("id");
  const evidence: Evidence[] = [];
  for (const e of data.evidence) {
    if (e.kind === "quote" && e.quote && textContains(args.pageText, e.quote)) {
      evidence.push({ id: nextId(), kind: "quote", label: e.label, quote: e.quote });
    } else if (e.kind === "photo_region" && e.photoIndex != null && e.photoIndex < args.photoCount) {
      const box = e.box2d?.map((n) => Math.max(0, Math.min(1000, Math.round(n)))) as [number, number, number, number] | undefined;
      evidence.push({ id: nextId(), kind: "photo_region", label: e.label, photoIndex: e.photoIndex, box2d: box });
    }
  }
  const rawBrand = data.brand?.replace(/\s+/g, " ").trim() || null;
  const brand = rawBrand ? (args.catalogue.find((m) => norm(m.brand) === norm(rawBrand))?.brand ?? rawBrand.slice(0, 60)) : null;
  const modelName = cleanModelName(brand, data.modelName);
  const picked = data.catalogueModelId ? (args.shortlist.find((m) => m.id === data.catalogueModelId) ?? null) : null;
  const model = picked ?? matchCatalogue(brand, modelName, args.catalogue);
  const confidence = model || modelName ? clamp01(data.confidence) : 0;
  const photoModelName = data.photoModel?.modelName.replace(/\s+/g, " ").trim() || null;
  const finalBrand = model?.brand ?? brand;
  const finalModel = model?.name ?? modelName;
  const version = data.version?.replace(/\s+/g, " ").trim().slice(0, 60) || null;
  const colourway = data.colourway?.replace(/\s+/g, " ").trim().slice(0, 60) || null;
  const alternatives = data.alternatives
    .map((a) => {
      const altModel = cleanModelName(finalBrand, a.modelName);
      const altCat = matchCatalogue(finalBrand, altModel, args.catalogue);
      return {
        brand: finalBrand,
        model: altCat?.name ?? altModel,
        version: a.version?.replace(/\s+/g, " ").trim().slice(0, 60) || null,
        colourway: a.colourway?.replace(/\s+/g, " ").trim().slice(0, 60) || null,
        confidence: clamp01(a.confidence),
        evidence: a.reason ? [{ id: `${nextId()}`, kind: "data_point" as const, label: a.reason.slice(0, 200) }] : [],
      };
    })
    // The same model as the best guess isn't an alternative.
    .filter((a) => a.model && !(norm(a.model) === norm(finalModel ?? "") && norm(a.version ?? "") === norm(version ?? "")))
    .sort((x, y) => y.confidence - x.confidence)
    .slice(0, 2);
  return {
    brand: finalBrand,
    brandConfidence: model ? Math.max(clamp01(data.brandConfidence ?? 0), confidence) : brand ? clamp01(data.brandConfidence ?? 0) : 0,
    modelName: finalModel,
    catalogueModelId: model?.id ?? null,
    inCatalogue: !!model,
    confidence,
    reasons: data.reasons,
    evidence,
    bestGuess: { brand: finalBrand, model: finalModel, version, colourway, confidence, evidence },
    alternatives,
    lensMatches: [],
    ...(!finalModel && finalBrand ? { brandOnlyReason: data.noModelReason?.trim() || "Gemini couldn't suggest any model from this listing." } : {}),
    photoModel: data.photoModel && photoModelName ? { modelName: photoModelName, confidence: clamp01(data.photoModel.confidence) } : null,
  };
}

/**
 * Identify on its own: the recheck_identification lead (tier "strong", one photo) and reopen (tier "fast").
 * A new investigation identifies inside the merged extract+identify call instead (examine.ts).
 */
export async function identifyProduct(
  gemini: GeminiClient,
  args: {
    facts: ListingFacts;
    images: CaseImage[];
    pageText: string;
    catalogue: CatalogueModel[];
    readReferenceImage: (p: string) => Promise<StoredImage | null>;
    /** Lead "recheck_identification" sends a single photo. */
    onlyPhotoIndex?: number;
    tier?: Tier;
  },
): Promise<IdentifyResult> {
  const shortlist = identifyShortlist(args.facts, args.catalogue);
  const photos = args.onlyPhotoIndex !== undefined ? args.images.filter((i) => i.index === args.onlyPhotoIndex) : args.images.slice(0, 6);
  const parts: Part[] = [
    {
      text:
        `Listing facts: ${JSON.stringify({ title: args.facts.title, brand: args.facts.brandText, model: args.facts.modelText })}\n` +
        `Listing text:\n"""\n${args.pageText.slice(0, 4000) || "(none)"}\n"""\n` +
        candidateList(shortlist),
    },
  ];
  for (const p of photos) parts.push({ text: `Listing photo ${p.index}:` }, imagePart(p));
  parts.push(...(await referenceParts(shortlist, args.readReferenceImage)));

  const { data } = await generateStructured(gemini, identifyWireSchema(shortlist.map((m) => m.id)), {
    stage: "identify",
    tier: args.tier ?? "fast",
    system: IDENTIFY_SYSTEM,
    parts,
  });
  const result = toIdentifyResult(data, { shortlist, catalogue: args.catalogue, pageText: args.pageText, photoCount: args.images.length });
  return withLevel(result, { facts: args.facts, pageText: args.pageText, catalogue: args.catalogue });
}

export function identifyCheck(result: IdentifyResult, args: { catalogue: CatalogueModel[]; hadImages: boolean }): CheckResult {
  const r = normaliseIdentify(result)!;
  const s = subjectOf(r, args.catalogue);
  const level = r.confidenceLevel!;
  const features: GeminiFeature[] = args.hadImages ? ["vision", "structured_output"] : ["structured_output"];
  const label = identifyLabel(r);
  const alts = (r.alternatives ?? []).map(candidateName).filter(Boolean);
  const alsoBe = alts.length ? ` It could also be ${alts.join(" or ")}.` : "";
  let status: CheckResult["status"];
  let summary: string;
  let confidence: number;
  if (s.tier === "none") {
    status = "unknown";
    summary = "I couldn't identify the brand from this listing's title, description or photos.";
    confidence = Math.max(r.brandConfidence ?? 0, r.confidence);
  } else if (s.tier === "brand") {
    status = "warn";
    summary = `It's a ${s.brand} pair, but I couldn't suggest a model from this listing${r.brandOnlyReason ? ` (${r.brandOnlyReason.replace(/\.$/, "")})` : ""}.`;
    confidence = r.brandConfidence ?? 0;
  } else {
    status = level === "possible" || level === "best_guess" ? "warn" : "pass";
    const noSampled = s.tier === "model" ? " This model isn't in our catalogue, so there's no sampled price to compare with." : "";
    summary =
      level === "confirmed" ? `Identified as the ${s.displayName}.${noSampled}`
      : level === "user_confirmed" ? `You confirmed this as the ${s.displayName}.${noSampled}`
      : level === "likely" ? `Likely the ${s.displayName}.${alsoBe}${noSampled}`
      : level === "possible" ? `${label}.${alsoBe} I'm not sure enough to be certain.`
      : `${label}.${alsoBe} It's a guess: the listing doesn't show the model clearly.`;
    confidence = r.confidence;
  }
  return {
    check: "identify",
    status,
    summary,
    evidence: r.evidence,
    confidence,
    geminiFeatures: features,
    details: {
      tier: s.tier,
      level,
      label,
      brand: s.brand,
      modelName: s.displayName,
      catalogueModelId: s.catalogue?.id ?? null,
      inCatalogue: !!s.catalogue,
      reasons: r.reasons,
      alternatives: r.alternatives ?? [],
      ...(r.brandOnlyReason ? { brandOnlyReason: r.brandOnlyReason } : {}),
    },
  };
}
