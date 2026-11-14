import type { Platform } from "@/schemas/domain";

/**
 * Keep only the listing's own content. Marketplace pages surround a listing with site navigation and with other
 * listings ("Similar items", "Sponsored", "You may also like"); those must never feed identification or condition,
 * and they cost tokens on every Gemini call.
 */

// A line that starts a block about other listings, site navigation or the seller (dropped until an own heading).
const FOREIGN_HEADINGS: RegExp[] = [
  /^similar (items|listings|products)$/i,
  /^explore related items$/i,
  /^(related )?sponsored items?( from .*)?$/i,
  /^sponsored$/i,
  /^people (who viewed this item )?also (viewed|bought|liked)$/i,
  /^you (may|might) also like$/i,
  /^recommended for you$/i,
  /^recently viewed( items)?$/i,
  /^more (items )?(from|by) this (seller|member)$/i,
  /^member's items$/i,
  /^seller's other items$/i,
  /^more to explore:?$/i,
  /^related searches$/i,
  /^about this seller$/i,
  /^shop by category$/i,
  /^today's picks$/i,
];

// Lines that start the listing's own sections again.
const OWN_HEADINGS: RegExp[] = [
  /^about this item$/i,
  /^item specifics$/i,
  /^item description from the seller$/i,
  /^description$/i,
  /^postage, returns and payments$/i,
  /^(price|condition|details|size|brand)$/i,
  /^picture \d+ of \d+$/i,
];

// eBay's header (account, category menu, search box) ends at the "Search" line.
const EBAY_NAV_START = /^skip to main content$/i;
const EBAY_NAV_END = /^search$/i;

/** Text kept only if at least this much survives; otherwise the page layout wasn't recognised and the text is left as is. */
const MIN_KEPT_CHARS = 200;

export function scopeListingText(text: string, platform: Platform): { text: string; removedLines: number } {
  const lines = text.split("\n");
  const kept: string[] = [];
  let mode: "own" | "foreign" | "nav" = "own";
  for (const raw of lines) {
    const line = raw.trim();
    if (mode === "nav") {
      if (EBAY_NAV_END.test(line)) mode = "own";
      continue;
    }
    if (platform === "ebay" && kept.length === 0 && EBAY_NAV_START.test(line)) {
      mode = "nav";
      continue;
    }
    if (FOREIGN_HEADINGS.some((r) => r.test(line))) {
      mode = "foreign";
      continue;
    }
    if (mode === "foreign" && OWN_HEADINGS.some((r) => r.test(line))) mode = "own";
    if (mode === "own") kept.push(raw);
  }
  const scoped = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (scoped.length < MIN_KEPT_CHARS && text.trim().length >= MIN_KEPT_CHARS) return { text, removedLines: 0 };
  return { text: scoped, removedLines: lines.length - kept.length };
}

// eBay image URLs: https://i.ebayimg.com/images/g/<id>/s-l1600.webp; other listings' cards use /thumbs/images/g/...
const EBAY_IMAGE = /^https:\/\/i\.ebayimg\.com\/(thumbs\/)?images\/g\/([^/]+)\/s-l(\d+)(\.\w+)/i;
export const EBAY_FULL_SIZE = 1600;

/** eBay photo id and size, or null for other URLs. `thumb` marks another listing's card image. */
export function ebayImage(url: string): { id: string; size: number; thumb: boolean; ext: string } | null {
  const m = EBAY_IMAGE.exec(url);
  return m ? { id: m[2], size: Number(m[3]), thumb: !!m[1], ext: m[4] } : null;
}

/** The full-size URL of an eBay gallery photo (gallery thumbnails are s-l64 / s-l140 / s-l500 of the same image). */
export function ebayFullSizeUrl(url: string): string {
  const img = ebayImage(url);
  return img && !img.thumb ? `https://i.ebayimg.com/images/g/${img.id}/s-l${EBAY_FULL_SIZE}${img.ext}` : url;
}

/**
 * Drop images that belong to other listings and collapse size variants of the same photo, keeping page order.
 * eBay: "/thumbs/" images are other listings' cards; one photo appears as s-l64, s-l400, s-l1600, ... so each id is
 * kept once, at full size.
 */
export function scopeListingImages(urls: string[], platform: Platform): string[] {
  if (platform !== "ebay") return [...new Set(urls)];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const url of urls) {
    const img = ebayImage(url);
    if (img?.thumb) continue; // another listing's thumbnail
    const key = img ? img.id : url;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(img ? ebayFullSizeUrl(url) : url);
  }
  return out;
}
