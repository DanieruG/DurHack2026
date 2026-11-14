import { z } from "zod";
import type { CheckResult, Evidence, GeminiFeature, IdentifyResult, ListingFacts } from "@/schemas/domain";
import type { CatalogueModel } from "@/schemas/seed";
import { getCatalogueCandidates, MAX_CANDIDATES } from "@/lib/catalogue";
import type { StoredImage } from "@/lib/images";
import { generateStructured } from "@/gemini/structured";
import { imagePart, type GeminiClient, type Part, type Tier } from "@/gemini/client";
import type { CaseImage } from "./intake";
import { clamp01, evidenceIds, textContains } from "./util";

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
- evidence: what you relied on: kind "quote" with exact text from this listing, or kind "photo_region" with photoIndex and box2d
  [ymin, xmin, ymax, xmax] normalised 0-1000 (e.g. tongue label, logo, sole pattern).`;

/** Identification fields (shared by identify and the merged extract+identify call). */
export function identifyWireSchema(ids: string[]) {
  return z.object({
    brand: z.string().nullish(),
    brandConfidence: z.number().min(0).max(1).nullish(),
    modelName: z.string().nullish(),
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
  });
}

export type IdentifyTier = "catalogue" | "model" | "brand" | "none";

/** What the downstream checks can rely on, after applying IDENTIFY_CONFIDENCE_MIN to each tier. */
export type Subject = {
  tier: IdentifyTier;
  brand: string | null;
  /** Model name without the brand. */
  modelName: string | null;
  /** "adidas Dropset 3", "adidas", or null. */
  displayName: string | null;
  catalogue: CatalogueModel | null;
};

const NO_SUBJECT: Subject = { tier: "none", brand: null, modelName: null, displayName: null, catalogue: null };

export function subjectOf(result: IdentifyResult | null | undefined, min: number, catalogue: CatalogueModel[]): Subject {
  if (!result) return NO_SUBJECT;
  const cat = result.catalogueModelId ? (catalogue.find((m) => m.id === result.catalogueModelId) ?? null) : null;
  const modelOk = result.confidence >= min && (!!cat || !!result.modelName);
  const brand = cat?.brand ?? result.brand ?? null;
  // A confidently named model implies its brand (and covers cases stored before brand was recorded).
  const brandOk = !!brand && (modelOk || (result.brandConfidence ?? 0) >= min);
  if (!brandOk) return NO_SUBJECT;
  if (!modelOk) return { tier: "brand", brand, modelName: null, displayName: brand, catalogue: null };
  const modelName = cat?.name ?? result.modelName!;
  return { tier: cat ? "catalogue" : "model", brand, modelName, displayName: `${brand} ${modelName}`, catalogue: cat };
}

/** Verdict rule R1 fires only when not even the brand is known. */
export function brandKnown(result: IdentifyResult | null | undefined, min: number, catalogue: CatalogueModel[]): boolean {
  return subjectOf(result, min, catalogue).tier !== "none";
}

/** Exact catalogue match at or above the confidence threshold (the sampled price comparison needs this). */
export function passesGate(result: IdentifyResult | null | undefined, min: number): boolean {
  return !!result && result.catalogueModelId !== null && result.confidence >= min;
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
  return {
    brand: model?.brand ?? brand,
    brandConfidence: model ? Math.max(clamp01(data.brandConfidence ?? 0), confidence) : brand ? clamp01(data.brandConfidence ?? 0) : 0,
    modelName: model?.name ?? modelName,
    catalogueModelId: model?.id ?? null,
    inCatalogue: !!model,
    confidence,
    reasons: data.reasons,
    evidence,
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
  return toIdentifyResult(data, { shortlist, catalogue: args.catalogue, pageText: args.pageText, photoCount: args.images.length });
}

export function identifyCheck(
  result: IdentifyResult,
  args: { min: number; catalogue: CatalogueModel[]; hadImages: boolean },
): CheckResult {
  const s = subjectOf(result, args.min, args.catalogue);
  const features: GeminiFeature[] = args.hadImages ? ["vision", "structured_output"] : ["structured_output"];
  const guess = result.modelName && result.brand ? `${result.brand} ${result.modelName}` : null;
  let status: CheckResult["status"];
  let summary: string;
  let confidence: number;
  switch (s.tier) {
    case "catalogue":
      status = "pass";
      summary = `Identified as the ${s.displayName}.`;
      confidence = result.confidence;
      break;
    case "model":
      status = "pass";
      summary = `Identified as the ${s.displayName}. This model isn't in our catalogue, so there's no sampled price to compare with.`;
      confidence = result.confidence;
      break;
    case "brand":
      status = "warn";
      summary = guess
        ? `It's a ${s.brand} pair. It might be the ${guess}, but I'm not confident enough to rely on that.`
        : `It's a ${s.brand} pair, but this listing doesn't show the exact model.`;
      confidence = result.brandConfidence ?? 0;
      break;
    default:
      status = "unknown";
      summary = "I couldn't identify the brand from this listing's title, description or photos.";
      confidence = Math.max(result.brandConfidence ?? 0, result.confidence);
  }
  return {
    check: "identify",
    status,
    summary,
    evidence: result.evidence,
    confidence,
    geminiFeatures: features,
    details: {
      tier: s.tier,
      brand: s.brand,
      modelName: s.displayName,
      catalogueModelId: s.catalogue?.id ?? null,
      inCatalogue: !!s.catalogue,
      reasons: result.reasons,
      gatePassed: s.tier === "catalogue",
    },
  };
}
