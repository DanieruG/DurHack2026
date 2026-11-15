import { z } from "zod";
import type { IdentifyResult, ListingData, ListingFacts, Platform } from "@/schemas/domain";
import { listingDataPart } from "./listingData";
import type { CatalogueModel } from "@/schemas/seed";
import type { StoredImage } from "@/lib/images";
import { generateStructured } from "@/gemini/structured";
import type { GeminiClient } from "@/gemini/client";
import { EXTRACT_SYSTEM, ExtractWireSchema, extractParts, toListingFacts } from "./extract";
import { candidateList, IDENTIFY_SYSTEM, identifyShortlist, identifyWireSchema, referenceParts, searchHintPart, toIdentifyResult } from "./identify";
import type { CaseImage } from "./intake";

/**
 * Extract and identify in ONE Flash call (low thinking): the listing text and photos are sent once instead of twice,
 * which roughly halves the tokens and saves a full round trip. Pro is used only by the recheck_identification lead.
 */
export const EXAMINE_SYSTEM = `${EXTRACT_SYSTEM}

Also fill "identification":
${IDENTIFY_SYSTEM}`;

export function examineWireSchema(ids: string[]) {
  return ExtractWireSchema.extend({ identification: identifyWireSchema(ids) });
}

export async function examineListing(
  gemini: GeminiClient,
  args: {
    pageText: string;
    images: CaseImage[];
    platform: Platform;
    catalogue: CatalogueModel[];
    readReferenceImage: (p: string) => Promise<StoredImage | null>;
    /** The user's marketplace search (a hint, never a fact about this listing). */
    searchQuery?: string | null;
    /** This listing's fields from the page's own data: facts, sent so Gemini only fills the gaps. */
    listing?: ListingData;
  },
): Promise<{ facts: ListingFacts; identify: IdentifyResult }> {
  // Nothing is extracted yet, so shortlist the catalogue from the top of the (already scoped) page text.
  const own = [args.listing?.title?.value, args.listing?.model?.value].filter(Boolean).join("\n");
  const shortlist = identifyShortlist({ title: `${own}\n${args.pageText.slice(0, 2000)}` }, args.catalogue);
  const parts = extractParts(args.pageText, args.images, args.platform);
  parts.splice(1, 0, ...listingDataPart(args.listing));
  parts.push({ text: candidateList(shortlist) }, ...(await referenceParts(shortlist, args.readReferenceImage)), ...searchHintPart(args.searchQuery));
  const { data } = await generateStructured(gemini, examineWireSchema(shortlist.map((m) => m.id)), {
    stage: "extract",
    tier: "fast",
    system: EXAMINE_SYSTEM,
    parts,
    thinking: "LOW",
  });
  const { identification, ...extract } = data as z.infer<ReturnType<typeof examineWireSchema>>;
  const photoCount = args.images.length;
  return {
    facts: toListingFacts(extract, { pageText: args.pageText, platform: args.platform, photoCount }),
    identify: toIdentifyResult(identification, { shortlist, catalogue: args.catalogue, pageText: args.pageText, photoCount }),
  };
}
