import { z } from "zod";
import type { Evidence, ListingFacts, Platform } from "@/schemas/domain";
import { generateStructured } from "@/gemini/structured";
import { imagePart, type GeminiClient, type Part } from "@/gemini/client";
import { redact } from "@/lib/redact";
import type { CaseImage } from "./intake";
import { evidenceIds, textContains } from "./util";

const FIELDS = ["title", "brand", "model", "size", "price", "condition", "style"] as const;

/** Gemini-friendly wire schema (nullable fields, flat arrays); mapped to ListingFacts in code. */
export const ExtractWireSchema = z.object({
  title: z.string().nullish(),
  brandText: z.string().nullish(),
  modelText: z.string().nullish(),
  sizeText: z.string().nullish(),
  sizeSystem: z.enum(["UK", "US", "EU", "unknown"]).nullish(),
  price: z.number().nonnegative().nullish(),
  currency: z.string().nullish(),
  conditionClaims: z.array(z.string()).default([]),
  /** The manufacturer's style code (e.g. "DC3728-003"), only when written in the listing or printed on a label in a photo. */
  styleCode: z.string().nullish(),
  /** The whole shoe (or pair) in photo 0: box2d [ymin, xmin, ymax, xmax] 0-1000. */
  shoeBox: z.array(z.number()).length(4).nullish(),
  evidence: z
    .array(
      z.object({
        field: z.enum(FIELDS),
        kind: z.enum(["quote", "photo_region"]),
        quote: z.string().nullish(),
        photoIndex: z.number().int().nonnegative().nullish(),
        box2d: z.array(z.number()).length(4).nullish(),
      }),
    )
    .default([]),
});
export type ExtractWire = z.infer<typeof ExtractWireSchema>;

export const EXTRACT_SYSTEM = `You read second-hand trainer listings for a careful buyer.
Rules:
- Extract ONLY what is written in the listing text or clearly visible in the photos. Leave a field null rather than guess.
- Focus on the main listing. Ignore page navigation, ads, "similar items", "you may also like" and recommendation sections.
- Never extract or repeat seller identity: no usernames, names, profile details, ratings, reviews of the seller, locations or contact details.
- conditionClaims: the seller's own words about condition, copied exactly (e.g. "worn twice", "Very good").
- For every field you fill, add one evidence entry: kind "quote" with the exact text copied from the listing,
  or kind "photo_region" with photoIndex and box2d [ymin, xmin, ymax, xmax] normalised 0-1000 for something read from a photo (e.g. a size label).
- price: the asking price as a number; currency as an ISO code (GBP, EUR, USD). Exclude postage and buyer-protection fees.
- sizeSystem: UK, US or EU only if stated or printed; otherwise "unknown". Never assume UK.
- styleCode: the manufacturer's style/product code (e.g. "DC3728-003", "GZ8851") only if written in the listing or printed on a
  label in a photo; add a "style" evidence entry. Otherwise null.
- shoeBox: box2d [ymin, xmin, ymax, xmax] 0-1000 around the whole shoe or pair in photo 0 (null if photo 0 doesn't show it).`;

export function extractParts(pageText: string, images: CaseImage[], platform: Platform): Part[] {
  const parts: Part[] = [
    { text: `Platform: ${platform}\nListing text (seller identity already removed):\n"""\n${pageText || "(no text captured)"}\n"""` },
  ];
  images.forEach((img) => {
    parts.push({ text: `Photo ${img.index}:` });
    parts.push(imagePart(img));
  });
  return parts;
}

const FIELD_LABEL: Record<(typeof FIELDS)[number], string> = {
  title: "Listing title",
  brand: "Brand",
  model: "Model",
  size: "Listed size",
  price: "Asking price",
  condition: "Seller's condition description",
  style: "Style code",
};

/** Map wire output to ListingFacts: verify quotes against the page text, drop seller identity, keep GBP only. */
export function toListingFacts(
  wire: ExtractWire,
  ctx: { pageText: string; platform: Platform; photoCount: number; idPrefix?: string },
): ListingFacts {
  const nextId = evidenceIds(ctx.idPrefix ?? "ext");
  const clean = (s: string | null | undefined) => {
    if (!s) return undefined;
    const r = redact(s).text.trim();
    return r || undefined;
  };
  const isGbp = !wire.currency || /^(gbp|£|uk)/i.test(wire.currency.trim());
  const valueFor = (field: (typeof FIELDS)[number]): string | number | undefined => {
    switch (field) {
      case "title": return clean(wire.title);
      case "brand": return clean(wire.brandText);
      case "model": return clean(wire.modelText);
      case "size": return clean(wire.sizeText);
      case "price": return isGbp && wire.price != null ? wire.price : undefined;
      case "condition": return wire.conditionClaims[0];
      case "style": return clean(wire.styleCode);
    }
  };

  const evidence: Evidence[] = [];
  for (const e of wire.evidence) {
    const value = valueFor(e.field);
    if (value === undefined) continue;
    if (e.kind === "quote" && e.quote && textContains(ctx.pageText, e.quote)) {
      evidence.push({ id: nextId(), kind: "quote", label: FIELD_LABEL[e.field], quote: clean(e.quote) ?? e.quote, value });
    } else if (e.kind === "photo_region" && e.photoIndex != null && e.photoIndex < ctx.photoCount) {
      const box = e.box2d ? (e.box2d.map((n) => Math.max(0, Math.min(1000, Math.round(n)))) as [number, number, number, number]) : undefined;
      evidence.push({ id: nextId(), kind: "photo_region", label: `${FIELD_LABEL[e.field]} (photo ${e.photoIndex + 1})`, photoIndex: e.photoIndex, box2d: box, value });
    } else {
      // Unverifiable quote: keep the fact visible but say plainly it isn't an exact quote.
      evidence.push({ id: nextId(), kind: "data_point", label: `${FIELD_LABEL[e.field]} (read from the listing, not an exact quote)`, value });
    }
  }
  // Every filled field gets at least one evidence entry.
  for (const field of FIELDS) {
    const value = valueFor(field);
    if (value === undefined || evidence.some((e) => e.label.startsWith(FIELD_LABEL[field]))) continue;
    evidence.push({ id: nextId(), kind: "data_point", label: `${FIELD_LABEL[field]} (read from the listing, not an exact quote)`, value });
  }

  const sizeSystem = wire.sizeSystem ?? undefined;
  // A style code needs its own evidence: a verified quote or a photo region (an unverifiable one is dropped).
  const styleCode = evidence.some((e) => e.label.startsWith("Style code") && (e.kind === "quote" || e.kind === "photo_region")) ? clean(wire.styleCode) : undefined;
  const styleFiltered = styleCode ? evidence : evidence.filter((e) => !e.label.startsWith("Style code"));
  const box = wire.shoeBox && ctx.photoCount > 0 ? (wire.shoeBox.map((n) => Math.max(0, Math.min(1000, Math.round(n)))) as [number, number, number, number]) : undefined;
  const shoeBox = box && box[2] - box[0] >= 50 && box[3] - box[1] >= 50 ? box : undefined;
  return {
    ...(styleCode && /^[A-Z0-9][A-Z0-9 -]{3,18}[A-Z0-9]$/i.test(styleCode) ? { styleCode } : {}),
    ...(shoeBox ? { shoeBox } : {}),
    title: clean(wire.title),
    brandText: clean(wire.brandText),
    modelText: clean(wire.modelText),
    sizeText: clean(wire.sizeText),
    sizeSystem: sizeSystem ?? (wire.sizeText ? "unknown" : undefined),
    priceGBP: isGbp && wire.price != null ? wire.price : undefined,
    platform: ctx.platform,
    conditionClaims: wire.conditionClaims.map((c) => clean(c)).filter((c): c is string => !!c).slice(0, 10),
    photoCount: ctx.photoCount,
    evidence: styleFiltered,
  };
}

export async function extractListing(
  gemini: GeminiClient,
  args: { pageText: string; images: CaseImage[]; platform: Platform },
): Promise<ListingFacts> {
  const { data } = await generateStructured(gemini, ExtractWireSchema, {
    stage: "extract",
    tier: "fast",
    thinking: "LOW",
    system: EXTRACT_SYSTEM,
    parts: extractParts(args.pageText, args.images, args.platform),
  });
  return toListingFacts(data, { pageText: args.pageText, platform: args.platform, photoCount: args.images.length });
}

/** Empty facts, used when extraction fails so the investigation can still reach a verdict. */
export function emptyFacts(platform: Platform, photoCount: number): ListingFacts {
  return { platform, photoCount, conditionClaims: [], evidence: [] };
}
