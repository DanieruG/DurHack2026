import { detectPlatform } from "@/lib/platform";
import { redact } from "@/lib/redact";
import { scopeListingImages, scopeListingText } from "@/lib/listingScope";
import { identifierVariants, pageUrlForCapture, scrubIdentifiers, scrubListingData, scrubUrl } from "@/lib/marketplace/redactSeller";
import { MAX_PAGE_TEXT, type Capture, type Platform } from "@/schemas/domain";
import { photosFromEmbedded, photosFromState, type EmbeddedData, type GalleryState } from "./gallery";
import type { PageFields } from "@/lib/marketplace/common";
import { extractListing, type ExtractedListing } from "@/lib/marketplace";
import { ListingDataSchema, type ListingData } from "@/schemas/domain";

/** What the in-page collector returns. Plain data only (it crosses the scripting boundary). */
export type RawCapture = {
  pageUrl: string;
  docTitle: string;
  ogTitle: string | null;
  h1: string | null;
  priceMeta: { amount: string; currency: string | null } | null;
  priceText: string | null;
  /** og:image and every image in the listing's gallery container (hidden slides, srcset, data-src included). */
  images: string[];
  /** Large images anywhere on the page; used only when neither the page data nor a gallery container gave any photos. */
  pageImages?: string[];
  /** Raw <script> contents that may hold the gallery's data (parsed in the panel, see gallery.ts). */
  embedded?: EmbeddedData;
  /** The page's JavaScript state (MAIN world), read only when the embedded JSON had no photos for this item. */
  state?: GalleryState;
  /** Visible listing fields read from the DOM (see PageFields). */
  fields?: PageFields;
  pageText: string;
};

export type { PageFields };

export type ListingPreview = {
  title: string;
  priceGBP: number | null;
  platform: Platform;
  photoCount: number;
  thumbnail: string | null;
  pageUrl: string;
};

/** Vinted allows 20 photos and eBay 24; the API accepts 32. The backend analyses up to MAX_IMAGES of them. */
export const MAX_CAPTURED_IMAGES = 24;

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
  const pageImages: string[] = [];
  const pushTo = (list: string[]) => (u: string | null) => {
    const a = abs(u);
    if (a && a.startsWith("https://") && !list.includes(a)) list.push(a);
  };
  const push = pushTo(images);
  document.querySelectorAll<HTMLMetaElement>('meta[property="og:image"], meta[property="og:image:url"]').forEach((m) => push(m.content));
  // Cards for other listings ("Similar items", "You may also like") link to a different listing page: skip their images.
  const listingPath = /\/(itm|items?|listing|products?|marketplace\/item)\//i;
  const otherListing = (el: Element) => {
    const href = el.closest<HTMLAnchorElement>("a[href]")?.href;
    if (!href) return false;
    try {
      const u = new URL(href, location.href);
      return u.host === location.host && listingPath.test(u.pathname) && u.pathname !== location.pathname;
    } catch {
      return false;
    }
  };
  // Every photo in the listing's own gallery, hidden or not: lazy-load attributes, srcset, <picture> sources and
  // slides that aren't shown yet (scopeListingImages later keeps one full-size URL per image id).
  const GALLERY =
    '[class*="ux-image-carousel"], [class*="ux-image-filmstrip"], [class*="ux-image-grid"], #PicturePanel, [data-testid="ux-image-carousel"], ' +
    '[class*="item-photos"], [data-testid^="item-photo"]';
  document.querySelectorAll<HTMLElement>(GALLERY).forEach((root) =>
    root.querySelectorAll<HTMLImageElement | HTMLSourceElement>("img, source").forEach((el) => {
      if (otherListing(el)) return;
      const attrs = ["data-zoom-src", "data-src", "data-original", "data-lazy-src"].map((a) => el.getAttribute(a));
      const sets = [el.getAttribute("srcset"), el.getAttribute("data-srcset")].map((v) => (v ? largestFromSrcset(v) : null));
      const src = el instanceof HTMLImageElement ? el.currentSrc || el.src : null;
      for (const u of [...attrs, ...sets, src]) push(u);
    }),
  );
  document.querySelectorAll<HTMLImageElement>("img").forEach((img) => {
    const r = img.getBoundingClientRect();
    const big = (img.naturalWidth >= 300 && img.naturalHeight >= 300) || (r.width >= 200 && r.height >= 200);
    if (!big || otherListing(img)) return;
    pushTo(pageImages)(img.srcset ? largestFromSrcset(img.srcset) : img.currentSrc || img.src);
  });

  // Embedded data: JSON-LD, JSON documents (e.g. __NEXT_DATA__) and inline scripts that may carry the gallery
  // (Next.js RSC chunks, eBay's mediaList). Read as text only; nothing on the page is executed or clicked.
  const embedded = { jsonLd: [] as string[], json: [] as string[], scripts: [] as string[] };
  let budget = 6_000_000;
  const keep = (list: string[], t: string) => {
    if (t.length > budget) return;
    budget -= t.length;
    list.push(t);
  };
  const MAY_HOLD_PHOTOS = /"(photos|images|mediaList|imageList|pictures|MSKU)"|__next_f|ebayimg\.com|vinted\.net/;
  document.querySelectorAll<HTMLScriptElement>("script:not([src])").forEach((sc) => {
    const t = sc.textContent ?? "";
    const type = (sc.type || "").toLowerCase();
    if (type === "application/ld+json") keep(embedded.jsonLd, t);
    else if (type === "application/json") {
      if (MAY_HOLD_PHOTOS.test(t)) keep(embedded.json, t);
    } else if (!type || type === "text/javascript" || type === "module") {
      // Every RSC chunk is kept (a row can span chunks); other scripts only if they look like gallery data.
      if (t.includes("self.__next_f.push") || MAY_HOLD_PHOTOS.test(t)) keep(embedded.scripts, t);
    }
  });

  const amount = meta('meta[property="product:price:amount"]') ?? meta('meta[property="og:price:amount"]') ??
    (document.querySelector('[itemprop="price"]')?.getAttribute("content") || null);
  const currency = meta('meta[property="product:price:currency"]') ?? meta('meta[property="og:price:currency"]') ??
    (document.querySelector('[itemprop="priceCurrency"]')?.getAttribute("content") || null);

  // Visible listing fields (plain text only).
  const clean = (t: string | null | undefined) => (t ?? "").replace(/\s+/g, " ").trim();
  const specifics: { label: string; value: string }[] = [];
  const about = document.querySelector('[data-testid="x-about-this-item"], #viTabs_0_is, [class*="ux-layout-section-evo"]');
  (about ?? document).querySelectorAll(".ux-labels-values__labels").forEach((labelEl) => {
    if (!about && !labelEl.closest('[class*="ux-layout-section-evo"]')) return;
    const valueEl = labelEl.nextElementSibling;
    if (!valueEl || !valueEl.classList.contains("ux-labels-values__values")) return;
    const label = clean(labelEl.textContent).replace(/:$/, "");
    // The condition value repeats itself behind "Read more"; keep the first sentence block.
    const value = clean(valueEl.querySelector("span")?.textContent ?? valueEl.textContent);
    if (label && value && label.length <= 60 && specifics.length < 40) specifics.push({ label, value: value.slice(0, 300) });
  });
  const grid = Array.from(document.querySelectorAll<HTMLImageElement>("button.ux-image-grid-item img, .ux-image-grid-item img"))
    .slice(0, 60)
    .map((img) => ({ src: img.getAttribute("src"), dataSrc: img.getAttribute("data-src") }));
  let pictureTotal: number | null = null;
  document.querySelectorAll("[aria-label]").forEach((el) => {
    const m = /^Picture \d+ of (\d+)$/i.exec(el.getAttribute("aria-label") ?? "");
    if (m) pictureTotal = Math.max(pictureTotal ?? 0, Number(m[1]));
  });
  const testIds: Record<string, string> = {};
  const leafTexts = (root: Element) => {
    const out: string[] = [];
    root.querySelectorAll("*").forEach((el) => {
      if (el.children.length || el.closest("button")) return;
      const t = clean(el.textContent);
      if (t) out.push(t);
    });
    return out;
  };
  for (const id of ["item-attributes-size", "item-attributes-status", "item-attributes-color", "item-attributes-material", "item-attributes-brand"]) {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) continue;
    const leaves = leafTexts(el);
    const value = leaves.slice(1).join(" ") || leaves[0];
    if (value) testIds[id] = value.slice(0, 200);
  }
  for (const id of ["item-price", "item-shipping-banner-price"]) {
    const el = document.querySelector(`[data-testid="${id}"]`);
    const t = clean(el?.firstElementChild?.textContent ?? el?.textContent);
    if (t) testIds[id] = t.slice(0, 100);
  }
  let photoTiles = 0;
  document.querySelectorAll('[data-testid^="item-photo-"]').forEach((el) => {
    const m = /^item-photo-(\d+)$/.exec(el.getAttribute("data-testid") ?? "");
    if (m) photoTiles = Math.max(photoTiles, Number(m[1]));
  });
  const descriptionFrame = !!document.querySelector('iframe[src*="ebaydesc.com"], iframe#desc_ifr');
  // The signed-in user's name/id in the header (eBay renders it from GHIdentConfig): collected only so it can be removed.
  const account: string[] = [];
  const pushAccount = (v: string | null | undefined) => {
    const t = clean(v);
    if (t && t.length >= 2 && t.length <= 64 && !account.includes(t)) account.push(t);
  };
  pushAccount(document.querySelector("#gh-ident-srvr-name, .gh-identity__greeting span span")?.textContent);
  document.querySelectorAll<HTMLScriptElement>("script:not([src])").forEach((sc) => {
    const t = sc.textContent ?? "";
    const cfg = /GHIdentConfig\s*=\s*(\{[^{}]{0,500}\})/.exec(t);
    if (cfg) {
      try {
        const o = JSON.parse(cfg[1]) as Record<string, unknown>;
        for (const k of ["fn", "id"]) if (typeof o[k] === "string") pushAccount(o[k] as string);
      } catch {
        /* not plain JSON */
      }
    }
    const auth = /"userAuth"\s*:\s*true\s*,\s*"userId"\s*:\s*"([^"]{2,64})"(?:\s*,\s*"fn"\s*:\s*"([^"]{2,64})")?/.exec(t);
    if (auth) {
      pushAccount(auth[1]);
      pushAccount(auth[2]);
    }
  });
  const fields = { specifics, grid, pictureTotal, testIds, photoTiles, descriptionFrame, account };

  const text = (document.body?.innerText ?? "").replace(/\n{3,}/g, "\n\n");
  const priceMatch = text.match(/£\s?\d{1,5}(?:[.,]\d{2})?/);

  return {
    pageUrl: location.href,
    docTitle: document.title,
    ogTitle: meta('meta[property="og:title"]'),
    h1: document.querySelector("h1")?.textContent?.trim() || null,
    priceMeta: amount ? { amount, currency } : null,
    priceText: priceMatch ? priceMatch[0] : null,
    images: images.slice(0, 120),
    pageImages: pageImages.slice(0, 60),
    embedded,
    fields,
    pageText: text.slice(0, 40_000),
  };
}

/**
 * Runs in the page's MAIN world (chrome.scripting.executeScript with world: "MAIN"), only when the embedded JSON had no
 * photos for this item, e.g. after Vinted's client-side navigation, when the page's inline data still describes the first
 * item opened. Reads state; never clicks or changes anything. Self-contained for the same reason as collectListing.
 */
export function collectGalleryState(): { texts: string[]; gallery: string[] } {
  const w = window as unknown as Record<string, unknown>;
  const texts: string[] = [];
  const gallery: string[] = [];
  const MAX = 6_000_000;
  const stringify = (v: unknown) => {
    try {
      const s = JSON.stringify(v);
      return s && s.length <= MAX ? s : null;
    } catch {
      return null; // circular or not serialisable
    }
  };
  const nf = w.__next_f;
  if (Array.isArray(nf)) {
    const flight = nf.map((e) => (Array.isArray(e) && e[0] === 1 && typeof e[1] === "string" ? e[1] : "")).join("");
    if (flight && flight.length <= MAX) texts.push(flight);
  }
  for (const k of ["__NEXT_DATA__", "__NUXT__", "__INITIAL_STATE__", "__PRELOADED_STATE__", "__APOLLO_STATE__"]) {
    if (w[k] !== undefined) {
      const s = stringify(w[k]);
      if (s) texts.push(s);
    }
  }
  // The gallery component's React props hold this item's full photo list, including photos behind a "+N" tile.
  const KEYS = ["photos", "images", "pictures", "mediaList", "imageList"];
  const clone = (v: unknown, depth: number): unknown => {
    if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    if (depth > 4 || typeof v !== "object" || v instanceof Node) return undefined;
    if (Array.isArray(v)) return v.slice(0, 40).map((x) => clone(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40)) {
      if (k.startsWith("_") || typeof x === "function") continue;
      const c = clone(x, depth + 1);
      if (c !== undefined) out[k] = c;
    }
    return out;
  };
  const roots = document.querySelectorAll<HTMLElement>(
    '[class*="item-photos"], [data-testid^="item-photo"], [class*="ux-image-carousel"], #PicturePanel, [data-testid="ux-image-carousel"]',
  );
  for (const root of Array.from(roots).slice(0, 4)) {
    const fiberKey = Object.keys(root).find((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    let fiber = fiberKey ? ((root as unknown as Record<string, unknown>)[fiberKey] as { memoizedProps?: unknown; return?: unknown } | null) : null;
    for (let i = 0; fiber && i < 30; i++) {
      const props = fiber.memoizedProps as Record<string, unknown> | null | undefined;
      if (props && typeof props === "object") {
        for (const holder of [props, props.item, props.data, (props.data as Record<string, unknown> | undefined)?.data]) {
          if (!holder || typeof holder !== "object") continue;
          for (const k of KEYS) {
            const arr = (holder as Record<string, unknown>)[k];
            if (Array.isArray(arr) && arr.length) {
              const s = stringify(clone(arr, 0));
              if (s && !gallery.includes(s)) gallery.push(s);
            }
          }
        }
      }
      fiber = fiber.return as typeof fiber;
    }
    if (gallery.length) break;
  }
  return { texts, gallery };
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

const galleryCtx = (raw: RawCapture) => ({ pageUrl: raw.pageUrl, platform: detectPlatform(raw.pageUrl), title: cleanTitle(raw) });

/** True when the embedded JSON had no photos for this item, so the page's JavaScript state should be read (MAIN world). */
export function needsPageState(raw: RawCapture): boolean {
  return photosFromEmbedded(raw.embedded, galleryCtx(raw)).length === 0;
}

/** Photos of this item from the page's data: embedded JSON first, else the page's JavaScript state. */
export function structuredPhotos(raw: RawCapture): string[] {
  const ctx = galleryCtx(raw);
  const embedded = photosFromEmbedded(raw.embedded, ctx);
  return embedded.length ? embedded : photosFromState(raw.state, ctx);
}

/** Every photo URL for this item, in gallery order: page data, then the gallery DOM, else large images on the page. */
export function listingPhotos(raw: RawCapture): string[] {
  const platform = detectPlatform(raw.pageUrl);
  const ok = (u: string) => /^https:\/\//.test(u) && u.length <= 2048;
  const found = [...structuredPhotos(raw), ...raw.images].filter(ok);
  // og:image alone means the gallery wasn't recognised: fall back to the large images on the page as before.
  const urls = found.length > 1 || !raw.pageImages?.length ? found : [...found, ...raw.pageImages.filter(ok)];
  // Thumbnails -> full-size photos, one per image id, other listings' cards dropped.
  return scopeListingImages(urls, platform);
}

/** Turn a raw page capture into the API `Capture` plus what the panel shows before investigating. */
/** This listing's fields from the page's own data (eBay, Vinted), or null on other sites. */
export function structuredListing(raw: RawCapture): ExtractedListing | null {
  return extractListing({ pageUrl: raw.pageUrl, embedded: raw.embedded, fields: raw.fields });
}

/** The listing data as sent: validated field by field, so one odd value never drops the rest. */
function validListing(listing: ListingData, captured: number): ListingData | undefined {
  const withPhotos: ListingData = { ...listing, photos: { captured, shown: listing.photos?.shown ?? null } };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(withPhotos)) {
    const one = ListingDataSchema.safeParse({ [k]: v });
    if (one.success && (one.data as Record<string, unknown>)[k] !== undefined) out[k] = (one.data as Record<string, unknown>)[k];
  }
  return Object.keys(out).length ? (out as ListingData) : undefined;
}

export function prepareCapture(raw: RawCapture): { capture: Capture; preview: ListingPreview } {
  const platform = detectPlatform(raw.pageUrl);
  const extracted = structuredListing(raw);
  // Identities found in the page data (seller and signed-in user): removed from everything sent, never sent themselves.
  const own = { title: extracted?.listing.title?.value, brand: extracted?.listing.brand?.value, model: extracted?.listing.model?.value };
  const ids = identifierVariants([...(extracted?.sellerIds ?? []), ...(raw.fields?.account ?? [])], own);
  // eBay: the gallery grid has every photo (JSON-LD lists only some). Elsewhere: page data, then the gallery DOM.
  const imageUrls = (extracted?.photos.length ? extracted.photos : listingPhotos(raw))
    .map((u) => scrubUrl(u, ids))
    .filter((u): u is string => !!u)
    .slice(0, MAX_CAPTURED_IMAGES);
  const listing = extracted ? validListing(scrubListingData(extracted.listing, ids), imageUrls.length) : undefined;
  // Only this listing's own text (no seller block, feedback or other listings), then the seller-identity filters.
  const scoped = scopeListingText(scrubIdentifiers(raw.pageText, ids), platform, own.title).text;
  const pageText = redactPageText(scoped);
  const cleanUrl = raw.pageUrl.length <= 2048 ? pageUrlForCapture(raw.pageUrl) : null;
  const pageUrl = cleanUrl && scrubUrl(cleanUrl, ids) ? cleanUrl : undefined;
  return {
    capture: {
      ...(pageUrl ? { pageUrl } : {}),
      ...(pageText ? { pageText } : {}),
      ...(imageUrls.length ? { imageUrls } : {}),
      ...(listing ? { listing } : {}),
    },
    preview: {
      title: listing?.title?.value.slice(0, 120) ?? cleanTitle(raw),
      priceGBP: listing?.priceGBP?.value ?? parsePriceGBP(raw),
      platform,
      photoCount: imageUrls.length,
      thumbnail: imageUrls[0] ?? null,
      pageUrl: pageUrl ?? raw.pageUrl,
    },
  };
}
