import type { ListingColour } from "@/schemas/domain";
import { analyseColours, describeColours, type BroadColour, type ColourAnalysis } from "@/lib/colour";
import { colourWordsIn, hasStyleCode } from "@/lib/colourWords";
import { MIN_OFFERS, type ColourMatch, type ShoppingOffer } from "@/lib/newPrices";

/**
 * Is each new-price offer the listing's colour? In order: the style code in the offer title (same), colour words in the
 * title compared with the listing's colours, then photo analysis of the offer's thumbnail (product shots: background
 * removed). Never presents a different colour as the same item.
 */

export const COLOURS_VARY = "Colours vary: price includes other colourways";
export const MAX_THUMBNAILS = 12;

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Compare title colours: same only when every colour the offer names is one of the listing's (so "Grey" or "White/Grey"
 * match a grey and white pair); any other colour named ("Silver Burgundy Plum", "White/Grey/Black") is a different
 * colourway.
 */
export function compareColours(offer: BroadColour[], listing: BroadColour[]): ColourMatch {
  if (!offer.length || !listing.length) return "unknown";
  return offer.every((c) => listing.includes(c)) ? "same" : "different";
}

/** Steps 1 and 2: style code, then colour words in the offer title. */
export function titleColourMatch(title: string, listing: ListingColour | undefined): { match: ColourMatch; evidence?: string } {
  if (!listing) return { match: "unknown" };
  if (listing.styleCode && hasStyleCode(title, listing.styleCode)) return { match: "same", evidence: `Style code ${listing.styleCode} in the title` };
  const words = colourWordsIn(title);
  if (!words.length) return { match: "unknown" };
  const evidence = `Title says ${words.map(capitalise).join("/")}`;
  return { match: compareColours(words, listing.names), evidence };
}

/** Step 3: the thumbnail's colours (weak). Unknown when the thumbnail is multi-coloured or unclear. */
export function thumbnailColourMatch(a: ColourAnalysis, listing: ListingColour): { match: ColourMatch; evidence: string } {
  const evidence = `Thumbnail looks ${describeColours(a) || "unclear"}`;
  if (a.multi || !a.colours.length || !listing.names.length) return { match: "unknown", evidence };
  // Weak evidence, so only the clearest cases: the thumbnail's main colour is the listing's main colour (same), or not
  // one of the listing's colours at all (different). Shading makes white read as grey, so anything else is unclear.
  const top = a.colours[0].name;
  if (top === listing.names[0]) return { match: "same", evidence };
  if (!listing.names.includes(top)) return { match: "different", evidence };
  return { match: "unknown", evidence };
}

/** Mark every offer's colour match (thumbnails only for offers the title couldn't settle). */
export async function matchOfferColours(
  offers: ShoppingOffer[],
  listing: ListingColour | undefined,
  opts: { fetchThumbnail?: (url: string) => Promise<Uint8Array | null>; analyse?: typeof analyseColours } = {},
): Promise<ShoppingOffer[]> {
  const analyse = opts.analyse ?? analyseColours;
  let thumbnails = 0;
  return Promise.all(
    offers.map(async (o) => {
      const t = titleColourMatch(o.title, listing);
      if (t.match !== "unknown" || !listing?.names.length || !o.thumbnailUrl || !opts.fetchThumbnail || thumbnails >= MAX_THUMBNAILS) {
        return { ...o, colourMatch: t.match, ...(t.evidence ? { colourEvidence: t.evidence } : {}) };
      }
      thumbnails++;
      try {
        const bytes = await opts.fetchThumbnail(o.thumbnailUrl);
        if (!bytes) return { ...o, colourMatch: "unknown" as const };
        const th = thumbnailColourMatch(await analyse(bytes), listing);
        return { ...o, colourMatch: th.match, colourEvidence: th.evidence };
      } catch {
        return { ...o, colourMatch: "unknown" as const };
      }
    }),
  );
}

/** Which offers the new-price figure uses: the same-colour ones when there are at least 3, otherwise all of them. */
export function colourBasis(offers: ShoppingOffer[]): { offers: ShoppingOffer[]; basis: "same_colour" | "all_colours"; note: string | null } {
  const same = offers.filter((o) => o.colourMatch === "same");
  if (same.length >= MIN_OFFERS) return { offers: same, basis: "same_colour", note: null };
  return { offers, basis: "all_colours", note: offers.length ? COLOURS_VARY : null };
}
