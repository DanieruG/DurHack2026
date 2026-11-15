import type { NewOffer, NewOffers } from "@/schemas/domain";
import { gbp, shortDate } from "./format";

/** The "Consider buying new" next move (pipeline/nextMoves.ts BUY_NEW_MOVE_ID); its offer cards repeat under it. */
export const BUY_NEW_MOVE_ID = "nm_buy_new";

/** Cards shown before "Show all". */
export const OFFERS_SHOWN = 3;

const money = (n: number) => gbp(Math.round(Math.abs(n) * 100) / 100);

/** "+£3 vs this listing", "£4 cheaper than this listing", "Same price as this listing". */
export function differenceText(differenceGBP: number): string {
  if (Math.abs(differenceGBP) < 0.005) return "Same price as this listing";
  return differenceGBP > 0 ? `+${money(differenceGBP)} vs this listing` : `${money(differenceGBP)} cheaper than this listing`;
}

/** The card's colour label: "Same colour", "Different colour" or "Colour unclear". */
export function colourLabel(o: Pick<NewOffer, "colourMatch">): string {
  return o.colourMatch === "same" ? "Same colour" : o.colourMatch === "different" ? "Different colour" : "Colour unclear";
}

/** The card's accessible name: "Nike Pegasus 40 at Decathlon UK, £45, £4 cheaper than this listing, same colour, lowest price, opens in a new tab". */
export function offerLabel(o: NewOffer): string {
  return [`${o.title} at ${o.retailer}`, gbp(o.priceGBP), differenceText(o.differenceGBP), colourLabel(o).toLowerCase(), o.isLowest ? "lowest price" : null, "opens in a new tab"]
    .filter(Boolean)
    .join(", ");
}

/** Only http(s) links become hrefs. */
export function safeHref(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Thumbnails load straight from the Shopping image host, over https only (the server already limits the host). */
export function safeThumbnail(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

export function offersFootnote(checkedOn: string): string {
  return `New prices checked ${shortDate(checkedOn)}. Check your size is in stock. Postage not included.`;
}

/** Shown when fewer than 3 retailers were found: the offers are listed but the verdict doesn't use them. */
export function notEnoughLine(data: NewOffers): string | null {
  if (data.enoughForComparison) return null;
  const n = data.offers.length;
  return `Only ${n} retailer${n === 1 ? "" : "s"} found, so this isn't used for the price verdict.`;
}

const COLOUR_ORDER = { same: 0, unknown: 1, different: 2 } as const;

/** Offers that can be opened: the listing's colour first, then cheapest (the server sorts; this keeps the panel honest). */
export function openableOffers(data: NewOffers): NewOffer[] {
  return data.offers
    .filter((o) => safeHref(o.url))
    .sort((a, b) => COLOUR_ORDER[a.colourMatch ?? "unknown"] - COLOUR_ORDER[b.colourMatch ?? "unknown"] || a.priceGBP - b.priceGBP);
}
