import type { Evidence, FieldSource, ListingData, ListingFacts, Platform } from "@/schemas/domain";
import { redact } from "@/lib/redact";
import type { Part } from "@/gemini/client";
import { gbp } from "./util";

/**
 * The extension reads this listing's own fields from the page's structured data (JSON-LD, page state) and visible
 * fields before anything goes to Gemini. Those fields win; Gemini only fills what is still missing. Every filled field
 * records where it came from (ListingFacts.fieldSources).
 */

/** Same labels as pipeline/extract.ts, so checks find the evidence for each field by its label. */
const LABEL = {
  title: "Listing title",
  brand: "Brand",
  model: "Model",
  size: "Listed size",
  price: "Asking price",
  condition: "Seller's condition description",
} as const;
type CoreField = keyof typeof LABEL;

const SOURCE_WORDS: Record<FieldSource, string> = {
  structured_data: "from the page's data",
  page_field: "from the listing's details",
  gemini: "read by Gemini",
};

const clean = (s: string | undefined): string | undefined => {
  if (!s) return undefined;
  const t = redact(s).text.replace(/\s+/g, " ").trim();
  return t || undefined;
};

/** Second-layer redaction of every text field (the extension redacts first). Empty fields are dropped. */
export function redactListingData(listing: ListingData | undefined): ListingData | undefined {
  if (!listing) return undefined;
  const out: ListingData = { ...listing };
  for (const k of ["title", "brand", "model", "condition", "colour", "material", "category", "uploadDate", "styleCode", "size"] as const) {
    const f = out[k];
    if (!f) continue;
    const v = clean(f.value);
    if (v) out[k] = { ...f, value: v };
    else delete out[k];
  }
  if (out.description) {
    const v = redact(out.description.value).text.trim();
    if (v) out.description = { ...out.description, value: v };
    else delete out.description;
  }
  if (out.itemSpecifics) out.itemSpecifics = out.itemSpecifics.map((s) => ({ label: s.label, value: clean(s.value) ?? "" })).filter((s) => s.value);
  if (out.sizeSystem?.quote) out.sizeSystem = { ...out.sizeSystem, quote: clean(out.sizeSystem.quote) };
  return out;
}

/** "Already known" block for the Gemini prompt: the listing's own fields, so Gemini only fills the gaps. */
export function listingDataPart(listing: ListingData | undefined): Part[] {
  if (!listing) return [];
  const lines: string[] = [];
  const add = (label: string, v: string | number | undefined) => v !== undefined && v !== "" && lines.push(`- ${label}: ${v}`);
  add("Title", listing.title?.value);
  add("Brand", listing.brand?.value);
  add("Model", listing.model?.value);
  add("Condition", listing.condition?.value);
  add("Colour", listing.colour?.value);
  add("Size", listing.size?.value);
  add("Size system", listing.sizeSystem?.value);
  if (listing.sizeOptions) add(`Size options (${listing.sizeOptions.label})`, listing.sizeOptions.options.map((o) => o.value).join(", "));
  add("Price (GBP)", listing.priceGBP?.value);
  add("Style code", listing.styleCode?.value);
  for (const s of listing.itemSpecifics ?? []) add(`Item specific "${s.label}"`, s.value);
  if (!lines.length) return [];
  return [
    {
      text:
        "Already read from this listing's own page data (these are facts about this listing: keep them and fill only what is missing; " +
        `a size listed under "Size options" is a choice, not this pair's size):\n${lines.join("\n")}`,
    },
  ];
}

type Extras = Omit<ListingFacts, "platform" | "conditionClaims" | "photoCount" | "evidence">;

/** The ListingFacts fields the page data gives, with their evidence. */
export function factsFromListing(listing: ListingData | undefined): { facts: Extras; evidence: Evidence[]; sources: Record<string, FieldSource>; claims: string[] } {
  const facts: Extras = {};
  const evidence: Evidence[] = [];
  const sources: Record<string, FieldSource> = {};
  const claims: string[] = [];
  if (!listing) return { facts, evidence, sources, claims };
  let n = 0;
  const ev = (label: string, value: string | number | undefined, source: FieldSource, extra: Partial<Evidence> = {}) =>
    evidence.push({ id: `ev_page_${++n}`, kind: "data_point", label: `${label} (${SOURCE_WORDS[source]})`, ...(value !== undefined ? { value } : {}), ...extra });

  const core: [CoreField, keyof Extras, { value: string; source: FieldSource } | undefined][] = [
    ["title", "title", listing.title],
    ["brand", "brandText", listing.brand],
    ["model", "modelText", listing.model],
    ["size", "sizeText", listing.sizeOptions ? undefined : listing.size],
    ["condition", "title", listing.condition],
  ];
  for (const [field, key, f] of core) {
    if (!f) continue;
    sources[field] = f.source;
    if (field === "condition") claims.push(f.value);
    else (facts as Record<string, unknown>)[key] = f.value;
    ev(LABEL[field], f.value, f.source);
  }
  if (listing.priceGBP) {
    facts.priceGBP = listing.priceGBP.value;
    sources.price = listing.priceGBP.source;
    ev(LABEL.price, listing.priceGBP.value, listing.priceGBP.source);
  }
  if (listing.sellerPrice) {
    facts.sellerPrice = listing.sellerPrice;
    ev(`Seller listed it at ${listing.sellerPrice.amount} ${listing.sellerPrice.currency}`, `${listing.sellerPrice.amount} ${listing.sellerPrice.currency}`, "structured_data");
  }
  if (listing.listPriceGBP) {
    facts.listPriceGBP = listing.listPriceGBP.value;
    ev("List price (RRP)", listing.listPriceGBP.value, listing.listPriceGBP.source);
  }
  if (listing.postageGBP) {
    facts.postageGBP = listing.postageGBP.value;
    sources.postage = listing.postageGBP.source;
    ev(`Postage ${listing.postageGBP.value === 0 ? "free" : gbp(listing.postageGBP.value)}`, listing.postageGBP.value, listing.postageGBP.source);
  }
  if (listing.buyerProtectionGBP) {
    facts.buyerProtectionGBP = listing.buyerProtectionGBP.value;
    ev(`Buyer protection ${gbp(listing.buyerProtectionGBP.value)}`, listing.buyerProtectionGBP.value, listing.buyerProtectionGBP.source);
  }
  if (listing.totalGBP && listing.priceGBP) {
    const includes = [...(listing.buyerProtectionGBP ? ["buyer_protection" as const] : []), ...(listing.postageGBP ? ["postage" as const] : [])];
    if (includes.length) {
      facts.totalGBP = listing.totalGBP.value;
      facts.totalIncludes = includes;
      sources.total = listing.totalGBP.source;
      ev(`Total ${gbp(listing.totalGBP.value)} ${totalWords(includes)}`, listing.totalGBP.value, listing.totalGBP.source);
    }
  }
  if (listing.sizeOptions) {
    facts.sizeOptions = listing.sizeOptions;
    sources.sizeOptions = listing.sizeOptions.source;
    const o = listing.sizeOptions.options;
    const inStock = o.filter((x) => !x.outOfStock).length;
    ev(`Size options: ${listing.sizeOptions.label} ${o.map((x) => x.value).join(", ")} (${inStock} of ${o.length} in stock)`, o.length, listing.sizeOptions.source);
  }
  if (listing.sizeSystem) {
    facts.sizeSystem = listing.sizeSystem.value;
    facts.sizeSystemFound = listing.sizeSystem;
    sources.sizeSystem = listing.sizeSystem.source;
    const where = { size_field: "the size field", size_menu: "the size menu", title: "the title", description: "the description", photo: "a photo" }[listing.sizeSystem.foundIn];
    ev(`Size system: ${listing.sizeSystem.value}, from ${where}`, listing.sizeSystem.value, listing.sizeSystem.source, listing.sizeSystem.quote ? { kind: "quote", quote: listing.sizeSystem.quote } : {});
  } else if (facts.sizeText) {
    facts.sizeSystem = "unknown";
  }
  if (listing.colour) {
    facts.colourText = listing.colour.value;
    sources.colour = listing.colour.source;
    ev(`Colour: ${listing.colour.value}`, listing.colour.value, listing.colour.source);
  }
  if (listing.styleCode) {
    facts.styleCode = listing.styleCode.value;
    sources.styleCode = listing.styleCode.source;
    ev(`Style code ${listing.styleCode.value}`, listing.styleCode.value, listing.styleCode.source);
  }
  if (listing.verificationAvailable !== undefined) facts.verificationAvailable = listing.verificationAvailable;
  if (listing.photos) facts.photosShown = listing.photos.shown;
  if (listing.notes?.length) {
    facts.notes = listing.notes;
    for (const note of listing.notes) ev(note, undefined, "page_field");
  }
  return { facts, evidence, sources, claims };
}

/** "including buyer protection and postage" */
export function totalWords(includes: ("buyer_protection" | "postage")[]): string {
  const words = includes.map((i) => (i === "buyer_protection" ? "protection" : "postage"));
  return `including ${words.join(" and ")}`;
}

const sameValue = (a: unknown, b: unknown) =>
  typeof a === "number" || typeof b === "number" ? Number(a) === Number(b) : String(a ?? "").trim().toLowerCase() === String(b ?? "").trim().toLowerCase();

/**
 * Merge Gemini's facts under the page data: a field the page data gives keeps that value (Gemini's evidence for it is
 * kept only when it agrees); Gemini fills the rest and is recorded as the source.
 */
export function mergeListingFacts(gemini: ListingFacts, listing: ListingData | undefined): ListingFacts {
  if (!listing) return { ...gemini, fieldSources: geminiSources(gemini) };
  const page = factsFromListing(listing);
  const sources: Record<string, FieldSource> = { ...page.sources };
  const geminiValue: Record<CoreField, unknown> = {
    title: gemini.title,
    brand: gemini.brandText,
    model: gemini.modelText,
    size: gemini.sizeText,
    price: gemini.priceGBP,
    condition: gemini.conditionClaims[0],
  };
  const pageValue: Record<CoreField, unknown> = {
    title: page.facts.title,
    brand: page.facts.brandText,
    model: page.facts.modelText,
    size: page.facts.sizeText,
    price: page.facts.priceGBP,
    condition: page.claims[0],
  };
  const multiSize = !!page.facts.sizeOptions;
  const keepGeminiEvidence = (e: Evidence) => {
    const field = (Object.keys(LABEL) as CoreField[]).find((f) => e.label.startsWith(LABEL[f]));
    if (!field) return true;
    if (field === "size" && multiSize) return false; // a size option is a choice, not this pair's size
    if (pageValue[field] === undefined) return true;
    return sameValue(e.value, pageValue[field]) && e.kind !== "data_point";
  };
  for (const f of Object.keys(LABEL) as CoreField[]) {
    if (!sources[f] && geminiValue[f] !== undefined && !(f === "size" && multiSize)) sources[f] = "gemini";
  }

  // Size system: the page data, else Gemini only when it read it from a photo (text was already searched in code).
  let sizeSystem = page.facts.sizeSystem;
  let sizeSystemFound = page.facts.sizeSystemFound;
  const sizeFromPhoto = gemini.evidence.some((e) => e.kind === "photo_region" && e.label.startsWith(LABEL.size));
  const sizeText = multiSize ? undefined : (page.facts.sizeText ?? gemini.sizeText);
  if (!multiSize && !sizeSystemFound && gemini.sizeSystem && gemini.sizeSystem !== "unknown" && (!page.facts.sizeText || sizeFromPhoto)) {
    sizeSystem = gemini.sizeSystem;
    if (sizeFromPhoto) sizeSystemFound = { value: gemini.sizeSystem, source: "gemini", foundIn: "photo" };
    sources.sizeSystem = "gemini";
  }
  if (!multiSize && sizeText && !sizeSystem) sizeSystem = "unknown";

  const claims = [...page.claims, ...gemini.conditionClaims.filter((c) => !page.claims.some((p) => sameValue(p, c)))].slice(0, 10);
  return {
    ...gemini,
    ...page.facts,
    title: page.facts.title ?? gemini.title,
    brandText: page.facts.brandText ?? gemini.brandText,
    modelText: page.facts.modelText ?? gemini.modelText,
    sizeText,
    sizeSystem: multiSize ? page.facts.sizeSystem : sizeSystem,
    ...(sizeSystemFound ? { sizeSystemFound } : {}),
    priceGBP: page.facts.priceGBP ?? gemini.priceGBP,
    conditionClaims: claims,
    evidence: [...page.evidence, ...gemini.evidence.filter(keepGeminiEvidence)],
    fieldSources: sources,
  };
}

function geminiSources(f: ListingFacts): Record<string, FieldSource> {
  const s: Record<string, FieldSource> = {};
  if (f.title) s.title = "gemini";
  if (f.brandText) s.brand = "gemini";
  if (f.modelText) s.model = "gemini";
  if (f.sizeText) s.size = "gemini";
  if (f.sizeSystem && f.sizeSystem !== "unknown") s.sizeSystem = "gemini";
  if (f.priceGBP !== undefined) s.price = "gemini";
  if (f.conditionClaims.length) s.condition = "gemini";
  return s;
}

/** Empty facts plus whatever the page data gives (used when the Gemini read fails). */
export function factsFromPageOnly(platform: Platform, photoCount: number, listing: ListingData | undefined): ListingFacts {
  return mergeListingFacts({ platform, photoCount, conditionClaims: [], evidence: [] }, listing);
}
