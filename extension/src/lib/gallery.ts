import { listingItemId } from "@/lib/listingScope";
import type { Platform } from "@/schemas/domain";

/**
 * This listing's photo URLs from the page's own data, before falling back to the DOM. A gallery often shows only the
 * first few photos with a "+N" tile; the rest are never rendered as <img>, but they are in the page's data.
 *
 * 1. Embedded JSON, read from <script> text in the page: JSON-LD (Product.image), Next.js data (__NEXT_DATA__ and the
 *    app-router RSC payload in self.__next_f.push(...) chunks), other application/json scripts, and eBay's gallery
 *    `mediaList` inside inline scripts.
 * 2. Only if that finds nothing: the page's JavaScript state, read in the MAIN world (see collectGalleryState).
 *
 * Only photos tied to this item are kept: arrays inside an object whose id is the listing's item id (from the URL), the
 * gallery's own React props, eBay's gallery data, or a JSON-LD Product that describes this page. Size variants are
 * collapsed later, by image id, in scopeListingImages.
 */

/** Raw <script> contents gathered in the page (plain strings: they cross the scripting boundary). */
export type EmbeddedData = { jsonLd: string[]; json: string[]; scripts: string[] };

/** Read in the MAIN world. `texts`: framework state as JSON/RSC text; `gallery`: photo arrays from the gallery's React props. */
export type GalleryState = { texts: string[]; gallery: string[] };

type Ctx = { pageUrl: string; platform: Platform; title: string };

const PHOTO_KEYS = new Set(["photos", "images", "pictures", "mediaList", "imageList", "gallery", "media"]);
const ITEM_ID_KEYS = ["item_id", "itemId", "listing_id", "listingId", "product_id", "productId"];
const MAX_PHOTOS = 32;

const IMAGE_URL = /^https:\/\/[^\s"'<>]+$/i;
const LOOKS_LIKE_IMAGE = /\.(jpe?g|png|webp|avif)(\?|$)|i\.ebayimg\.com\/|images\d*\.vinted\.net\//i;
const isImageUrl = (s: unknown): s is string => typeof s === "string" && s.length <= 2048 && IMAGE_URL.test(s) && LOOKS_LIKE_IMAGE.test(s);

/** Every image URL inside one photo entry (a URL string, or an object with url / thumbnails / originalImg ...). */
function urlsOfEntry(entry: unknown, depth = 0): string[] {
  if (isImageUrl(entry)) return [entry];
  if (depth > 3 || !entry || typeof entry !== "object") return [];
  const vals = Array.isArray(entry) ? entry : Object.values(entry as Record<string, unknown>);
  return vals.flatMap((v) => urlsOfEntry(v, depth + 1));
}

/** All URLs of a photo array, entry by entry (page order). */
function urlsOfArray(arr: unknown[]): string[] {
  return arr.slice(0, MAX_PHOTOS).flatMap((e) => urlsOfEntry(e));
}

/**
 * Walk parsed JSON and collect photo arrays tied to `itemId`: an object whose item_id/itemId/... (or plain `id`) equals the
 * item id puts its subtree in scope; an object naming a different item via an explicit item-id key takes it out again.
 */
export function scopedPhotoArrays(root: unknown, itemId: string | null): string[][] {
  const out: string[][] = [];
  if (!itemId) return out;
  const visit = (node: unknown, inScope: boolean, depth: number) => {
    if (depth > 60 || !node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const v of node) visit(v, inScope, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    const ids = [...ITEM_ID_KEYS, "id"].filter((k) => typeof obj[k] === "string" || typeof obj[k] === "number");
    let scoped = inScope;
    if (ids.some((k) => String(obj[k]) === itemId)) scoped = true;
    else if (ids.some((k) => ITEM_ID_KEYS.includes(k))) scoped = false;
    for (const [k, v] of Object.entries(obj)) {
      if (scoped && PHOTO_KEYS.has(k) && Array.isArray(v)) {
        const urls = urlsOfArray(v);
        if (urls.length) out.push(urls);
        continue;
      }
      visit(v, scoped, depth + 1);
    }
  };
  visit(root, false, 0);
  return out;
}

/** The array that starts at `text[start]` ("["), bracket-matched (strings and escapes respected), parsed; or null. */
export function arrayAt(text: string, start: number): unknown[] | null {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length && i - start < 2_000_000; i++) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") {
      if (--depth === 0) {
        try {
          const v = JSON.parse(text.slice(start, i + 1));
          return Array.isArray(v) ? v : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Arrays under `"key":[` anywhere in a script's text (for JSON embedded in JavaScript, e.g. eBay's mediaList). */
export function arraysByKey(text: string, key: string): unknown[][] {
  const out: unknown[][] = [];
  const re = new RegExp(`"${key}"\\s*:\\s*\\[`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const arr = arrayAt(text, m.index + m[0].length - 1);
    if (arr) out.push(arr);
    if (out.length >= 10) break;
  }
  return out;
}

const NEXT_F = /self\.__next_f\.push\(\s*(\[[\s\S]*\])\s*\)\s*;?\s*$/;

/** The decoded string of one `self.__next_f.push([1, "..."])` script, or null. */
export function nextFlightChunk(script: string): string | null {
  const m = NEXT_F.exec(script.trim());
  if (!m) return null;
  try {
    const arr = JSON.parse(m[1]) as unknown[];
    return arr[0] === 1 && typeof arr[1] === "string" ? arr[1] : null;
  } catch {
    return null;
  }
}

/** Parse the rows of a Next.js RSC payload ("1f:[...]", "2a:{...}") that are JSON. Other rows are skipped. */
export function rscRows(flight: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of flight.split("\n")) {
    const m = /^[0-9a-f]+:(?=[[{])/i.exec(line);
    if (!m) continue;
    try {
      rows.push(JSON.parse(line.slice(m[0].length)));
    } catch {
      /* text row or a row split oddly: skip */
    }
  }
  return rows;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** JSON-LD Product images, only from a Product that describes this listing (its URL names the item, or its name is the title). */
export function jsonLdPhotos(texts: string[], ctx: Ctx, itemId: string | null): string[] {
  const out: string[] = [];
  const page = (() => {
    try {
      return new URL(ctx.pageUrl);
    } catch {
      return null;
    }
  })();
  const sameListing = (u: unknown) => {
    if (typeof u !== "string") return false;
    if (itemId && u.includes(itemId)) return true;
    try {
      return !!page && new URL(u, page.href).pathname === page.pathname;
    } catch {
      return false;
    }
  };
  const products: Record<string, unknown>[] = [];
  const collect = (n: unknown, depth = 0) => {
    if (depth > 6 || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => collect(x, depth + 1));
    const o = n as Record<string, unknown>;
    const type = o["@type"];
    if (type === "Product" || (Array.isArray(type) && type.includes("Product"))) products.push(o);
    if (o["@graph"]) collect(o["@graph"], depth + 1);
  };
  for (const t of texts) {
    try {
      collect(JSON.parse(t));
    } catch {
      /* malformed JSON-LD: skip */
    }
  }
  for (const p of products) {
    const offers = Array.isArray(p.offers) ? p.offers : p.offers ? [p.offers] : [];
    const urls = [p.url, p["@id"], ...offers.map((o) => (o as Record<string, unknown>)?.url)].filter((u) => typeof u === "string");
    const name = typeof p.name === "string" ? norm(p.name) : "";
    const ok = urls.length ? urls.some(sameListing) : !!name && !!ctx.title && (norm(ctx.title).includes(name) || name.includes(norm(ctx.title)));
    if (!ok) continue;
    const imgs = Array.isArray(p.image) ? p.image : p.image ? [p.image] : [];
    for (const img of imgs.slice(0, MAX_PHOTOS)) {
      const u = typeof img === "string" ? img : (img as Record<string, unknown>)?.contentUrl ?? (img as Record<string, unknown>)?.url;
      if (isImageUrl(u)) out.push(u);
    }
  }
  return out;
}

/** Photos from framework data: Next.js RSC rows, __NEXT_DATA__ / application/json documents, eBay mediaList. */
function frameworkPhotos(docs: unknown[], scriptTexts: string[], ctx: Ctx, itemId: string | null): string[] {
  const sets = docs.flatMap((d) => scopedPhotoArrays(d, itemId));
  if (ctx.platform === "ebay") {
    for (const t of scriptTexts) if (t.includes('"mediaList"')) for (const arr of arraysByKey(t, "mediaList")) sets.push(urlsOfArray(arr));
  }
  // The fullest set first (a page can carry the same gallery several times, or a trimmed copy of it).
  return sets.sort((a, b) => b.length - a.length).flat();
}

/** Step 1: this item's photos from the page's embedded JSON (empty when none are found). */
export function photosFromEmbedded(data: EmbeddedData | undefined, ctx: Ctx): string[] {
  if (!data) return [];
  const itemId = listingItemId(ctx.pageUrl, ctx.platform);
  const docs: unknown[] = [];
  for (const t of data.json) {
    try {
      docs.push(JSON.parse(t));
    } catch {
      /* not JSON */
    }
  }
  const flight = data.scripts.map(nextFlightChunk).filter((c): c is string => c !== null).join("");
  if (flight) docs.push(...rscRows(flight));
  const others = data.scripts.filter((s) => nextFlightChunk(s) === null);
  return dedupe([...frameworkPhotos(docs, others, ctx, itemId), ...jsonLdPhotos(data.jsonLd, ctx, itemId)]);
}

/** Step 2: this item's photos from the page's JavaScript state (MAIN world). */
export function photosFromState(state: GalleryState | undefined, ctx: Ctx): string[] {
  if (!state) return [];
  const itemId = listingItemId(ctx.pageUrl, ctx.platform);
  const docs: unknown[] = [];
  for (const t of state.texts) {
    try {
      docs.push(JSON.parse(t));
    } catch {
      docs.push(...rscRows(t)); // the decoded self.__next_f payload
    }
  }
  const scoped = frameworkPhotos(docs, [], ctx, itemId);
  // The gallery component's own props: this item's photos by construction.
  const fromProps = state.gallery.flatMap((t) => {
    try {
      const v = JSON.parse(t);
      return Array.isArray(v) ? urlsOfArray(v) : [];
    } catch {
      return [];
    }
  });
  return dedupe([...fromProps, ...scoped]);
}

function dedupe(urls: string[]): string[] {
  return [...new Set(urls)];
}
