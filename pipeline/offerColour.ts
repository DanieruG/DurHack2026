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
const sameSet = (a: BroadColour[], b: BroadColour[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Compare colours: same when the main colours agree (or the sets do), different when they don't. */
export function compareColours(offer: BroadColour[], listing: BroadColour[]): ColourMatch {
  if (!offer.length || !listing.length) return "unknown";
  if (offer[0] === listing[0] || sameSet(offer, listing)) return "same";
  return "different";
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
  const top = a.colours[0].name;
  const top2 = a.colours.filter((c) => c.share >= 0.15).slice(0, 2).map((c) => c.name);
  if (top === listing.names[0] || sameSet(top2, listing.names)) return { match: "same", evidence };
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
