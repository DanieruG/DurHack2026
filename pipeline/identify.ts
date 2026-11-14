import { z } from "zod";
import type { CheckResult, Evidence, GeminiFeature, IdentifyResult, ListingFacts } from "@/schemas/domain";
import type { CatalogueModel } from "@/schemas/seed";
import { getCatalogueCandidates, MAX_CANDIDATES } from "@/lib/catalogue";
import type { StoredImage } from "@/lib/images";
import { generateStructured } from "@/gemini/structured";
import { imagePart, type GeminiClient, type Part } from "@/gemini/client";
import type { CaseImage } from "./intake";
import { clamp01, evidenceIds, textContains } from "./util";

export const IDENTIFY_SYSTEM = `You identify the exact trainer model in a second-hand listing, sceptically.
- Choose ONLY from the candidate catalogue ids given. Compare the listing photos with the reference images and the listing text.
- If you are not sure, return catalogueModelId null. A wrong identification is far worse than none.
- Similar-looking models and versions (e.g. Pegasus 39 vs 40) must be told apart by visible details or text; if you can't, return null.
- confidence: your probability (0-1) that the chosen id is exactly right.
- evidence: what you relied on: kind "quote" with exact listing text, or kind "photo_region" with photoIndex and box2d [ymin, xmin, ymax, xmax] normalised 0-1000 (e.g. tongue label, logo, sole pattern).`;

function wireSchema(ids: string[]) {
  return z.object({
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

export function passesGate(result: IdentifyResult | null | undefined, min: number): boolean {
  return !!result && result.catalogueModelId !== null && result.confidence >= min;
}

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
  },
): Promise<IdentifyResult> {
  const candidates = getCatalogueCandidates(args.facts, args.catalogue);
  const shortlist = candidates.slice(0, Math.max(MAX_CANDIDATES, Math.min(candidates.length, 20)));
  const refs = await Promise.all(
    shortlist.slice(0, MAX_CANDIDATES).map(async (m) => ({ m, img: m.referenceImg ? await args.readReferenceImage(m.referenceImg) : null })),
  );
  const photos = args.onlyPhotoIndex !== undefined ? args.images.filter((i) => i.index === args.onlyPhotoIndex) : args.images.slice(0, 6);

  const parts: Part[] = [
    {
      text:
        `Listing facts: ${JSON.stringify({ title: args.facts.title, brand: args.facts.brandText, model: args.facts.modelText })}\n` +
        `Listing text:\n"""\n${args.pageText.slice(0, 4000) || "(none)"}\n"""\n` +
        `Candidates:\n${shortlist.map((m) => `- ${m.id}: ${m.brand} ${m.name} (aka ${m.aliases.join(", ") || "-"})`).join("\n")}`,
    },
  ];
  for (const p of photos) parts.push({ text: `Listing photo ${p.index}:` }, imagePart(p));
  for (const r of refs) if (r.img) parts.push({ text: `Reference image for ${r.m.id}:` }, imagePart(r.img));

  const { data } = await generateStructured(gemini, wireSchema(shortlist.map((m) => m.id)), {
    stage: "identify",
    tier: "strong",
    system: IDENTIFY_SYSTEM,
    parts,
  });

  const nextId = evidenceIds("id");
  const evidence: Evidence[] = [];
  for (const e of data.evidence) {
    if (e.kind === "quote" && e.quote && textContains(args.pageText, e.quote)) {
      evidence.push({ id: nextId(), kind: "quote", label: e.label, quote: e.quote });
    } else if (e.kind === "photo_region" && e.photoIndex != null && e.photoIndex < args.images.length) {
      const box = e.box2d?.map((n) => Math.max(0, Math.min(1000, Math.round(n)))) as [number, number, number, number] | undefined;
      evidence.push({ id: nextId(), kind: "photo_region", label: e.label, photoIndex: e.photoIndex, box2d: box });
    }
  }
  const id = data.catalogueModelId && shortlist.some((m) => m.id === data.catalogueModelId) ? data.catalogueModelId : null;
  return { catalogueModelId: id, confidence: id ? clamp01(data.confidence) : clamp01(Math.min(data.confidence, 0.5)), reasons: data.reasons, evidence };
}

export function identifyCheck(
  result: IdentifyResult,
  args: { min: number; catalogue: CatalogueModel[]; hadImages: boolean },
): CheckResult {
  const model = args.catalogue.find((m) => m.id === result.catalogueModelId);
  const passed = passesGate(result, args.min);
  const features: GeminiFeature[] = args.hadImages ? ["vision", "structured_output"] : ["structured_output"];
  const summary = passed
    ? `Identified as the ${model!.brand} ${model!.name}.`
    : model
      ? `It might be the ${model.brand} ${model.name}, but I'm not confident enough to rely on that.`
      : "I couldn't identify the exact model from the photos and text.";
  return {
    check: "identify",
    status: passed ? "pass" : "unknown",
    summary,
    evidence: result.evidence,
    confidence: result.confidence,
    geminiFeatures: features,
    details: { catalogueModelId: result.catalogueModelId, modelName: model ? `${model.brand} ${model.name}` : null, reasons: result.reasons, gatePassed: passed },
  };
}
