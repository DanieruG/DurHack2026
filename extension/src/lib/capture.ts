import { detectPlatform } from "@/lib/platform";
import { redact } from "@/lib/redact";
import { MAX_PAGE_TEXT, type Capture, type Platform } from "@/schemas/domain";

/** What the in-page collector returns. Plain data only (it crosses the scripting boundary). */
export type RawCapture = {
  pageUrl: string;
  docTitle: string;
  ogTitle: string | null;
  h1: string | null;
  priceMeta: { amount: string; currency: string | null } | null;
  priceText: string | null;
  images: string[];
  pageText: string;
};

export type ListingPreview = {
  title: string;
  priceGBP: number | null;
  platform: Platform;
  photoCount: number;
  thumbnail: string | null;
  pageUrl: string;
};

export const MAX_CAPTURED_IMAGES = 12;

/**
 * Runs inside the listing tab via chrome.scripting.executeScript. Must stay self-contained:
 * it is serialised with Function.prototype.toString, so it cannot reference anything outside itself.
 */
export function collectListing(): RawCapture {
  const meta = (sel: string) => document.querySelector<HTMLMetaElement>(sel)?.content?.trim() || null;
  const abs = (u: string | null | undefined) => {
    if (!u) return null;
    try {
      return new URL(u, location.href).href;
    } catch {
      return null;
    }
  };
  const largestFromSrcset = (srcset: string) => {
    let best: { url: string; w: number } | null = null;
    for (const part of srcset.split(",")) {
      const [url, size] = part.trim().split(/\s+/);
      const w = size ? parseFloat(size) : 1;
      if (url && (!best || w > best.w)) best = { url, w };
    }
    return best?.url ?? null;
  };

  const images: string[] = [];
  const push = (u: string | null) => {
    const a = abs(u);
    if (a && a.startsWith("https://") && !images.includes(a)) images.push(a);
  };
  document.querySelectorAll<HTMLMetaElement>('meta[property="og:image"], meta[property="og:image:url"]').forEach((m) => push(m.content));
  // Cards for other listings ("Similar items", "You may also like") link to a different listing page: skip their images.
  const listingPath = /\/(itm|items?|listing|products?|marketplace\/item)\//i;
  const otherListing = (img: HTMLImageElement) => {
    const href = img.closest<HTMLAnchorElement>("a[href]")?.href;
    if (!href) return false;
    try {
      const u = new URL(href, location.href);
      return u.host === location.host && listingPath.test(u.pathname) && u.pathname !== location.pathname;
    } catch {
      return false;
    }
  };
  document.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const r = img.getBoundingClientRect();
    const big = (img.naturalWidth >= 300 && img.naturalHeight >= 300) || (r.width >= 200 && r.height >= 200);
    if (!big || otherListing(img)) return;
    push(img.srcset ? largestFromSrcset(img.srcset) : img.currentSrc || img.src);
  });

  const amount = meta('meta[property="product:price:amount"]') ?? meta('meta[property="og:price:amount"]') ??
    (document.querySelector('[itemprop="price"]')?.getAttribute("content") || null);
  const currency = meta('meta[property="product:price:currency"]') ?? meta('meta[property="og:price:currency"]') ??
    (document.querySelector('[itemprop="priceCurrency"]')?.getAttribute("content") || null);

  const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n");
  const priceMatch = text.match(/£\s?\d{1,5}(?:[.,]\d{2})?/);

  return {
    pageUrl: location.href,
    docTitle: document.title,
    ogTitle: meta('meta[property="og:title"]'),
    h1: document.querySelector("h1")?.textContent?.trim() || null,
    priceMeta: amount ? { amount, currency } : null,
    priceText: priceMatch ? priceMatch[0] : null,
    images: images.slice(0, 24),
    pageText: text.slice(0, 40_000),
  };
}

const SELLER_LINE = /member since|followers|following|last seen|active \d+\s*(min|hour|day)|\breviews?\s*\(\d+\)|(^|\s)@[\w.]{2,}/i;

/** First layer of seller-identity redaction (the backend runs a second). */
export function redactPageText(text: string): string {
  // Same rules as the backend (seller cards, usernames, handles), plus a few extra line filters.
  return redact(text.split("\n").filter((line) => !SELLER_LINE.test(line)).join("\n")).text.slice(0, MAX_PAGE_TEXT);
}

const SITE_SUFFIX = /\s+[|·–—-]\s+[^|·–—-]{2,40}$/;

export function cleanTitle(raw: RawCapture): string {
  const t = (raw.ogTitle || raw.h1 || raw.docTitle || "").replace(/\s+/g, " ").trim();
  const stripped = t.replace(SITE_SUFFIX, "");
  return (stripped.length >= 4 ? stripped : t).slice(0, 120) || "Untitled listing";
}

export function parsePriceGBP(raw: RawCapture): number | null {
  if (raw.priceMeta && (!raw.priceMeta.currency || /^gbp$/i.test(raw.priceMeta.currency))) {
    const n = Number(raw.priceMeta.amount.replace(",", "."));
    if (Number.isFinite(n) && n > 0) return n;
  }
  const m = raw.priceText?.match(/£\s?(\d{1,5}(?:[.,]\d{2})?)/);
  if (m) {
    const n = Number(m[1].replace(",", "."));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Turn a raw page capture into the API `Capture` plus what the panel shows before investigating. */
export function prepareCapture(raw: RawCapture): { capture: Capture; preview: ListingPreview } {
  const imageUrls = raw.images.filter((u) => /^https:\/\//.test(u) && u.length <= 2048).slice(0, MAX_CAPTURED_IMAGES);
  const pageText = redactPageText(raw.pageText);
  const pageUrl = /^https?:\/\//.test(raw.pageUrl) && raw.pageUrl.length <= 2048 ? raw.pageUrl : undefined;
  return {
    capture: {
      ...(pageUrl ? { pageUrl } : {}),
      ...(pageText ? { pageText } : {}),
      ...(imageUrls.length ? { imageUrls } : {}),
    },
    preview: {
      title: cleanTitle(raw),
      priceGBP: parsePriceGBP(raw),
      platform: detectPlatform(raw.pageUrl),
      photoCount: imageUrls.length,
      thumbnail: imageUrls[0] ?? null,
      pageUrl: raw.pageUrl,
    },
  };
}
