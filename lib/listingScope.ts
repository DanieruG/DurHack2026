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
  /^seller business information/i,
  /^seller contact information/i,
  /^manufacturer \/ eu responsible person/i,
  /^detailed seller ratings$/i,
  /^seller feedback\b/i,
  /^popular categories from this shop$/i,
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
const EBAY_NAV_END = /^search(advanced)?$/i;

/** Text kept only if at least this much survives; otherwise the page layout wasn't recognised and the text is left as is. */
const MIN_KEPT_CHARS = 200;

export function scopeListingText(text: string, platform: Platform, ownTitle?: string): { text: string; removedLines: number } {
  const lines = text.split("\n");
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  // The listing's own title starts its own content again (Vinted renders "Member's items" and "Similar items" first).
  const title = ownTitle ? norm(ownTitle) : "";
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
    if (mode === "foreign" && (OWN_HEADINGS.some((r) => r.test(line)) || (title.length >= 8 && norm(line) === title))) mode = "own";
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

// Vinted image URLs: https://images1.vinted.net/t/<photo id>/<size>/<file>.webp?s=<signature>. Sizes are 70x100, 150x210,
// 310x430 and f800 (also /tc/<photo id>/<file> for full size). The signature covers the size, so a thumbnail can't be
// rewritten to a larger size: the largest variant seen is kept.
const VINTED_IMAGE = /^https:\/\/images\d*\.vinted\.net\/(?:t|tc)\/([^/]+)\/(?:([^/]+)\/)?[^/?]+/i;

/** Vinted photo id and a size rank (bigger is larger), or null for other URLs. */
export function vintedImage(url: string): { id: string; rank: number } | null {
  const m = VINTED_IMAGE.exec(url);
  if (!m) return null;
  const size = m[2] ?? "";
  const f = /^f(\d+)$/i.exec(size);
  const wh = /^(\d+)x(\d+)$/i.exec(size);
  // /tc/ (no size segment) is the original upload; f800 is 800px on the long side; WxH are crops.
  const rank = !m[2] || /\/tc\//i.test(url) ? Number.MAX_SAFE_INTEGER : f ? Number(f[1]) ** 2 * 2 : wh ? Number(wh[1]) * Number(wh[2]) : 0;
  return { id: m[1], rank };
}

/** The listing's item id from its URL (Vinted /items/<id>-slug, eBay /itm/<id> or /itm/<slug>/<id>), or null. */
export function listingItemId(pageUrl: string, platform: Platform): string | null {
  let path: string;
  try {
    path = new URL(pageUrl).pathname;
  } catch {
    return null;
  }
  const m =
    platform === "vinted" ? /\/items\/(\d+)/.exec(path) : platform === "ebay" ? /\/itm\/(?:[^/]+\/)?(\d{6,})/.exec(path) : /\/(?:items?|listing|products?|marketplace\/item)\/(\d+)/i.exec(path);
  return m ? m[1] : null;
}

/**
 * Drop images that belong to other listings and collapse size variants of the same photo, keeping page order.
 * eBay: "/thumbs/" images are other listings' cards; one photo appears as s-l64, s-l400, s-l1600, ... so each id is
 * kept once, at full size. Vinted: one photo appears as 70x100 ... f800, each with its own signature, so each id is kept
 * once, at the largest size seen.
 */
export function scopeListingImages(urls: string[], platform: Platform): string[] {
  if (platform === "vinted") {
    const best = new Map<string, { url: string; rank: number }>();
    for (const url of urls) {
      const img = vintedImage(url);
      const key = img ? img.id : url;
      const rank = img ? img.rank : 0;
      const prev = best.get(key);
      if (!prev || rank > prev.rank) best.set(key, { url, rank }); // Map keeps first-seen order on update
    }
    return [...best.values()].map((v) => v.url);
  }
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
