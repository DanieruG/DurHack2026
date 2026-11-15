import { z } from "zod";
import catalogueJson from "@/data/catalogue.json";
import sizeChartsJson from "@/data/sizecharts.json";
import { listingItemId } from "@/lib/listingScope";
import { userSizeUK } from "@/lib/observed";
import { brandToken, catalogueTokens, chartForBrand, deriveTokens, extractSize, namesAnyModel, normaliseTitle, toUK, type ModelTokens } from "@/lib/titleMatch";
import { CatalogueModelSchema, SizeChartSchema } from "@/schemas/seed";
import { MAX_OBSERVED_LISTINGS, ObservedListingSchema, type ObservedListing, type Profile } from "@/schemas/domain";
import { nextFlightChunk, rscRows } from "./gallery";
import { topResults, type TopResult } from "./topResults";

/**
 * "Survey this search" (Feature A1/A2). On an eBay or Vinted search results page, one click reads the listing cards shown
 * (embedded page data first, else the card elements) and keeps them on this device for 24 hours. The background worker
 * does this automatically when a search is submitted (see autoSurvey.ts); the panel can also do it on demand. When the
 * user later investigates a listing on the same platform, the most recent survey goes with the case. Nothing is sent to
 * the server until then, and no seller names, usernames, ratings or locations are ever kept.
 */

export type SurveyPlatform = "ebay" | "vinted";
export type SearchPage = { platform: SurveyPlatform; query: string; key: string };

export const SURVEY_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_SURVEY_CARDS = MAX_OBSERVED_LISTINGS;

/** A surveyed card: exactly the API's ObservedListing, so it can be sent as is. */
export type SurveyCard = ObservedListing;

export type SurveyRecord = {
  key: string;
  platform: SurveyPlatform;
  query: string;
  createdAt: string;
  updatedAt: string;
  cards: SurveyCard[];
  /** The results page the cards were last read from (see scanUrlOf): reading the same page again replaces them. */
  scanUrl?: string;
};

// ---------- search pages ----------

/** Lowercase, punctuation stripped, whitespace collapsed: "Nike  Pegasus-40!" -> "nike pegasus 40". */
export function normaliseQuery(q: string): string {
  return q
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** eBay /sch/ pages (query _nkw) and Vinted /catalog pages (query search_text); null for anything else. */
export function searchPageOf(url: string | null | undefined): SearchPage | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  let platform: SurveyPlatform | null = null;
  let raw = "";
  if (/(^|\.)ebay\.[a-z.]+$/.test(host) && /^\/sch\//.test(u.pathname)) {
    platform = "ebay";
    raw = u.searchParams.get("_nkw") ?? "";
  } else if (/(^|\.)vinted\.[a-z.]+$/.test(host) && /^\/catalog(\/|$)/.test(u.pathname)) {
    platform = "vinted";
    raw = u.searchParams.get("search_text") ?? "";
  }
  if (!platform) return null;
  const query = normaliseQuery(raw);
  // A category page with no search words is its own survey, not one shared by every category.
  const scope = query ? "" : `:${u.searchParams.get("_sacat") ?? u.pathname.replace(/\/+$/, "")}`;
  return { platform, query, key: `${platform}:${query}${scope}` };
}

/** A results page's identity for "read it again": host, path and every parameter except tracking, sorted. */
export function scanUrlOf(url: string): string {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.entries()].filter(([k]) => !/^(_trk|_trkparms|_trksid|rt|ref|referrer|utm_|mkcid|mkrid|campid|toolid|customid|siteid)/i.test(k)).sort(([a], [b]) => a.localeCompare(b));
    return `${u.hostname}${u.pathname}?${params.map(([k, v]) => `${k}=${v}`).join("&")}`;
  } catch {
    return url;
  }
}

// ---------- in-page collector ----------

/** One card as read in the page: only card fields; the card's other text never leaves the page. */
export type RawSearchCard = {
  href: string;
  title: string;
  priceText: string | null;
  img: string | null;
  sizeText: string | null;
  condition: string | null;
  sponsored: boolean;
  format: "auction" | "buy_it_now" | "unknown";
  /** Vinted's card link title: "Nike Pegasus 40, brand: Nike, condition: Very good, size: 43, £30.00, £32.20 includes Buyer Protection". */
  summary: string | null;
};

export type RawSearchCapture = { pageUrl: string; cards: RawSearchCard[]; embedded: { json: string[]; scripts: string[] } };

/**
 * Runs inside the search results tab via chrome.scripting.executeScript, only when the user clicks Survey. Must stay
 * self-contained (it is serialised with Function.prototype.toString). Reads; never clicks or scrolls. Seller names,
 * ratings and locations are never read: each field comes from its own element, and flags are decided here.
 */
export function collectSearchResults(): RawSearchCapture {
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
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
  const imgOf = (root: Element) => {
    const img = root.querySelector<HTMLImageElement>("img");
    if (!img) return null;
    const set = img.getAttribute("srcset") || img.getAttribute("data-srcset");
    for (const u of [img.getAttribute("data-src"), set ? largestFromSrcset(set) : null, img.currentSrc || img.getAttribute("src")]) {
      const a = abs(u);
      if (a && a.startsWith("https://")) return a;
    }
    return null;
  };
  const CONDITION = /\b(brand new|new with box|new with tags|new without box|new without tags|new other(?: \(see details\))?|new|pre-owned|used|like new|very good|good|satisfactory|acceptable|for parts or not working)\b/i;
  const SIZE = /\b(?:(?:uk|us|eu)\s*)?(?:shoe\s*)?size\s*:?\s*(?:uk|us|eu)?\s*\d{1,2}(?:\.\d)?\b/i;
  const isEbay = /(^|\.)ebay\./i.test(location.hostname);
  const cards: RawSearchCard[] = [];
  const seen = new Set<Element>();

  // Blocks that are not this search's results: "Recently viewed", related searches, sponsored or recommended carousels.
  const FOREIGN_HEADING = /^(your )?(recently viewed|related searches|related sponsored|sponsored|similar items|items you may like|you may also like|people also viewed|recommended for you|today's picks|more to explore|inspired by)/i;
  const FOREIGN_CONTAINER = /carousel|recent|merch|related-search|recommend|similar|also-viewed|also-bought|inspired|btf|pf-bottom/i;
  const headingBefore = (el: Element) => {
    // The nearest heading before this element, looking at earlier siblings and then up the tree.
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
      for (let p = n.previousElementSibling; p; p = p.previousElementSibling) {
        const h = p.matches("h1, h2, h3, h4, [role='heading']") ? p : p.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > [role='heading'], :scope > * > h2, :scope > * > h3");
        if (h) return clean(h.textContent);
      }
    }
    return "";
  };
  const inForeignBlock = (root: Element, stop: Element | null) => {
    for (let a = root.parentElement; a && a !== document.body && a !== stop; a = a.parentElement) {
      if (FOREIGN_CONTAINER.test(`${a.className?.toString?.() ?? ""} ${a.id} ${a.getAttribute("data-viewport") ?? ""}`)) return true;
    }
    return FOREIGN_HEADING.test(headingBefore(root));
  };
  // The search words, to drop cards that have nothing to do with them (eBay's "matching fewer words" river, strays).
  const queryWords = (() => {
    try {
      const u = new URL(location.href);
      return (u.searchParams.get("_nkw") ?? u.searchParams.get("search_text") ?? "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((w) => w.length > 1);
    } catch {
      return [] as string[];
    }
  })();
  const onTopic = (title: string) => {
    if (queryWords.length < 2) return true;
    const t = title.toLowerCase().replace(/[^a-z0-9]+/g, " ");
    return queryWords.some((w) => t.includes(w));
  };

  if (isEbay) {
    // Candidate cards over the whole page, then narrowed to the results list itself.
    const roots: Element[] = [];
    document.querySelectorAll<HTMLElement>("li.s-item, li.s-card, div.s-card, [data-listingid]").forEach((node) => {
      const root = node.closest("li") ?? node;
      if (seen.has(root)) return;
      seen.add(root);
      if (root.querySelector('a[href*="/itm/"]')) roots.push(root);
    });
    seen.clear();
    const list = document.querySelector("ul.srp-results, #srp-river-results ul, .srp-river-main ul");
    let chosen: Element[];
    if (list) chosen = roots.filter((r) => list.contains(r));
    else {
      // No known results list: keep the largest group of cards that share a list parent (the real results), if it is most of them.
      const groups = new Map<Element, Element[]>();
      for (const r of roots) {
        const g = r.closest("ul, ol") ?? r.parentElement ?? document.body;
        groups.set(g, [...(groups.get(g) ?? []), r]);
      }
      const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
      chosen = best.length * 2 >= roots.length ? best : roots;
    }
    const marker = document.querySelector("[class*='REWRITE_START']") ?? [...document.querySelectorAll("li, div, h2, h3")].find((e) => e.children.length < 3 && /^results matching fewer words/i.test(clean(e.textContent)));
    const kept: Element[] = [];
    for (const r of chosen) {
      if (marker && (marker.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING)) continue; // after "results matching fewer words"
      if (inForeignBlock(r, list)) continue;
      kept.push(r);
    }
    kept.forEach((root) => {
      const link = root.querySelector<HTMLAnchorElement>('a[href*="/itm/"]');
      if (!link) return;
      const title = clean(root.querySelector(".s-item__title, .s-card__title, [role='heading']")?.textContent)
        .replace(/^new listing\s*/i, "")
        .replace(/\s*opens in a new window or tab$/i, "");
      if (!title || /^shop on ebay$/i.test(title) || !onTopic(title)) return;
      const text = clean(root.textContent);
      const auction = /\b\d+\s+bids?\b/i.test(text) || /\bplace bid\b/i.test(text) || /\btime left\b/i.test(text);
      const subtitle = clean(root.querySelector(".SECONDARY_INFO, .s-card__subtitle, .s-item__subtitle")?.textContent);
      const sponsored =
        !!root.querySelector('[aria-label*="Sponsored" i], [class*="sponsored" i], [data-sponsored]') ||
        /\bsponsored\b/i.test(clean(root.querySelector(".s-item__sep, .s-card__footer, .s-item__detail--primary")?.textContent));
      cards.push({
        href: link.href,
        title,
        priceText: clean(root.querySelector(".s-item__price, .s-card__price")?.textContent) || null,
        img: imgOf(root),
        sizeText: SIZE.exec(subtitle)?.[0] ?? null,
        condition: CONDITION.exec(subtitle)?.[0] ?? null,
        sponsored,
        format: auction ? "auction" : /\bbuy it now\b/i.test(text) ? "buy_it_now" : "unknown",
        summary: null,
      });
    });
  } else {
    // Only the results grid: not the "recently viewed" or home-feed blocks Vinted can show elsewhere on the page.
    const grid = document.querySelector('.feed-grid, [data-testid="feed-grid"]');
    (grid ?? document)
      .querySelectorAll<HTMLElement>('[data-testid^="product-item-id-"], .new-item-box__container, .feed-grid__item')
      .forEach((node) => {
        const root = node.closest(".feed-grid__item") ?? node;
        if (seen.has(root)) return;
        seen.add(root);
        const link = root.querySelector<HTMLAnchorElement>('a[href*="/items/"]');
        if (!link) return;
        const summary = clean(link.getAttribute("title") || root.querySelector("[title*='£']")?.getAttribute("title")) || null;
        const title = clean(root.querySelector('[data-testid$="--description-title"]')?.textContent) || (summary ?? "").split(/,\s*(?:brand|condition|size):/i)[0];
        if (!title || !onTopic(title)) return;
        const badge = clean(root.querySelector('[data-testid*="bump" i], [data-testid*="promot" i], [class*="bump" i]')?.textContent);
        cards.push({
          href: link.href,
          title,
          priceText: clean(root.querySelector('[data-testid$="--price-text"]')?.textContent) || null,
          img: imgOf(root),
          sizeText: null,
          condition: null,
          sponsored: !!badge || /\b(bumped|promoted|sponsored)\b/i.test(clean(root.querySelector('[data-testid$="--overlay"], [data-testid$="--status"]')?.textContent)),
          format: "unknown",
          summary,
        });
      });
  }

  // Vinted's page data (Next.js RSC chunks, JSON scripts) as text; parsed in the panel, which keeps card fields only.
  const embedded = { json: [] as string[], scripts: [] as string[] };
  if (!isEbay) {
    let budget = 6_000_000;
    document.querySelectorAll<HTMLScriptElement>("script:not([src])").forEach((sc) => {
      const t = sc.textContent ?? "";
      if (t.length > budget || !/\/items\//.test(t) && !t.includes("self.__next_f.push")) return;
      const type = (sc.type || "").toLowerCase();
      if (type === "application/json") embedded.json.push(t);
      else if (t.includes("self.__next_f.push")) embedded.scripts.push(t);
      else return;
      budget -= t.length;
    });
  }
  return { pageUrl: location.href, cards: cards.slice(0, 400), embedded };
}

// ---------- parsing (panel) ----------

/** "£30.00" -> 30 GBP. A price range ("£20.00 to £30.00") is a multi-variant listing: no single price. */
export function parsePrice(text: string | null | undefined): { price: number | null; currency: string | null } {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t || /\bto\b|–|-\s*[£$€]/i.test(t)) return { price: null, currency: null };
  const m = /([£$€])\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s?([£$€])/.exec(t);
  if (!m) return { price: null, currency: null };
  const sym = m[1] ?? m[4];
  const raw = (m[2] ?? m[3]).replace(/,(?=\d{3}\b)/g, "").replace(",", ".");
  const price = Number(raw);
  return Number.isFinite(price) && price > 0 ? { price, currency: sym === "£" ? "GBP" : sym === "€" ? "EUR" : "USD" } : { price: null, currency: null };
}

/** Vinted's link title: title, brand, condition, size and the item price (the price without buyer protection). */
export function parseVintedSummary(summary: string | null): { title: string | null; condition: string | null; size: string | null; priceText: string | null } {
  if (!summary) return { title: null, condition: null, size: null, priceText: null };
  const field = (k: string) => new RegExp(`,\\s*${k}:\\s*([^,]+)`, "i").exec(summary)?.[1]?.trim() ?? null;
  const title = summary.split(/,\s*(?:brand|condition|size|status):/i)[0].split(/,\s*£/)[0].trim() || null;
  const prices = [...summary.matchAll(/£\s?\d+(?:[.,]\d{1,2})?(?!\d)(\s*includes buyer protection)?/gi)];
  const item = prices.find((p) => !p[1]);
  return { title, condition: field("condition") ?? field("status"), size: field("size"), priceText: item ? item[0] : null };
}

/** The listing's canonical URL (no query or fragment) and its item id. */
function canonical(href: string, platform: SurveyPlatform): { url: string; id: string } | null {
  try {
    const u = new URL(href);
    if (u.protocol !== "https:") return null;
    const id = listingItemId(u.href, platform);
    if (!id) return null;
    return { url: platform === "ebay" ? `${u.origin}/itm/${id}` : `${u.origin}${u.pathname}`, id };
  } catch {
    return null;
  }
}

const httpsOrUndefined = (u: string | null | undefined) => (u && /^https:\/\//i.test(u) && u.length <= 2048 ? u : undefined);
const trimTo = (s: string | null | undefined, n: number) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  return t || undefined;
};

/** A card from the card elements; null when it has no listing id or title. */
export function cardFromDom(raw: RawSearchCard, platform: SurveyPlatform, seenAt: string): SurveyCard | null {
  const c = canonical(raw.href, platform);
  const vinted = platform === "vinted" ? parseVintedSummary(raw.summary) : null;
  const title = trimTo(raw.title || vinted?.title, 300);
  if (!c || !title) return null;
  const { price, currency } = parsePrice(raw.priceText ?? vinted?.priceText);
  const card = {
    id: c.id,
    title,
    price,
    currency,
    url: c.url,
    thumbnailUrl: httpsOrUndefined(raw.img),
    sizeText: trimTo(raw.sizeText ?? vinted?.size, 60),
    condition: trimTo(raw.condition ?? vinted?.condition, 60),
    sponsored: raw.sponsored,
    ...(platform === "ebay" ? { buyingFormat: raw.format } : {}),
    priceBasis: platform === "vinted" ? ("excl_buyer_protection" as const) : ("listed" as const),
    seenAt,
  };
  const parsed = ObservedListingSchema.safeParse(card);
  return parsed.success ? parsed.data : null;
}

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);

/** Vinted item objects in the page data: an id, a title, an /items/ URL and a price. Only card fields are kept. */
function vintedItems(root: unknown, out: Obj[], depth = 0) {
  if (depth > 40 || !root || typeof root !== "object" || out.length >= 400) return;
  if (Array.isArray(root)) {
    for (const v of root) vintedItems(v, out, depth + 1);
    return;
  }
  const o = root as Obj;
  if (str(o.id) && typeof o.title === "string" && typeof o.url === "string" && /\/items\/\d+/.test(o.url) && o.price !== undefined) {
    out.push(o);
    return;
  }
  for (const v of Object.values(o)) vintedItems(v, out, depth + 1);
}

function vintedPrice(p: unknown, currency: unknown): { price: number | null; currency: string | null } {
  const o = p && typeof p === "object" ? (p as Obj) : null;
  const amount = Number(o ? o.amount : p);
  const cur = str(o ? (o.currency_code ?? o.currency) : currency);
  return Number.isFinite(amount) && amount > 0 ? { price: amount, currency: cur ? cur.toUpperCase() : null } : { price: null, currency: null };
}

/** Vinted cards from the page's embedded data (preferred over the card elements). */
export function cardsFromEmbedded(embedded: RawSearchCapture["embedded"], pageUrl: string, seenAt: string): SurveyCard[] {
  const docs: unknown[] = [];
  for (const t of embedded.json) {
    try {
      docs.push(JSON.parse(t));
    } catch {
      /* not JSON */
    }
  }
  const flight = embedded.scripts.map(nextFlightChunk).filter((c): c is string => c !== null).join("");
  if (flight) docs.push(...rscRows(flight));
  const items: Obj[] = [];
  for (const d of docs) vintedItems(d, items);
  const out: SurveyCard[] = [];
  for (const o of items) {
    let href: string;
    try {
      href = new URL(String(o.url), pageUrl).href;
    } catch {
      continue;
    }
    const c = canonical(href, "vinted");
    if (!c) continue;
    const photo = o.photo && typeof o.photo === "object" ? (o.photo as Obj) : null;
    const thumbs = Array.isArray(photo?.thumbnails) ? (photo!.thumbnails as Obj[]) : [];
    const thumb = str(thumbs.find((t) => t && t.type === "thumb310x430")?.url) ?? str(photo?.url);
    const { price, currency } = vintedPrice(o.price, o.currency);
    const card = {
      id: c.id,
      title: trimTo(str(o.title), 300) ?? "",
      price,
      currency,
      url: c.url,
      thumbnailUrl: httpsOrUndefined(thumb),
      sizeText: trimTo(str(o.size_title ?? o.size), 60),
      condition: trimTo(str(o.status), 60),
      sponsored: o.promoted === true || o.is_promoted === true || o.isPromoted === true,
      priceBasis: "excl_buyer_protection" as const,
      seenAt,
    };
    const parsed = ObservedListingSchema.safeParse(card);
    if (parsed.success && !out.some((x) => x.id === parsed.data.id)) out.push(parsed.data);
  }
  return out;
}

/** Every card on the page: page data first (Vinted), the card elements filling gaps, in page order, one per listing id. */
export function cardsFromCapture(raw: RawSearchCapture, platform: SurveyPlatform, seenAt: string): SurveyCard[] {
  const dom = raw.cards.map((c) => cardFromDom(c, platform, seenAt)).filter((c): c is SurveyCard => !!c);
  const data = platform === "vinted" ? cardsFromEmbedded(raw.embedded, raw.pageUrl, seenAt) : [];
  const fromData = new Map(data.map((c) => [c.id, c]));
  const out = new Map<string, SurveyCard>();
  for (const d of dom) {
    const e = fromData.get(d.id);
    out.set(d.id, e ? { ...d, ...stripUndefined(e), sponsored: e.sponsored || d.sponsored, thumbnailUrl: e.thumbnailUrl ?? d.thumbnailUrl } : d);
  }
  // The page data is used to fill in the cards drawn on the page. It is only a source of cards itself when none were drawn:
  // after Vinted navigates within the page it can still hold the previous page's feed, which isn't this search.
  if (!dom.length) for (const e of data) if (!out.has(e.id)) out.set(e.id, e);
  return [...out.values()];
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>;
}

// ---------- the local cache ----------

const stale = (c: SurveyCard, now: number) => now - Date.parse(c.seenAt) > SURVEY_TTL_MS;

/**
 * Drop cards not seen for 24 hours (each card ages on its own, so a search you keep reading stays fresh while what has
 * left the page ages out), then keep at most 300 cards in total, dropping the oldest cards first.
 */
export function pruneSurveys(surveys: SurveyRecord[], now: number): SurveyRecord[] {
  const live = surveys.map((s) => ({ ...s, cards: s.cards.filter((c) => !stale(c, now)) })).filter((s) => s.cards.length > 0);
  const all = live.flatMap((s) => s.cards.map((c) => ({ key: s.key, c })));
  if (all.length > MAX_SURVEY_CARDS) {
    const keep = new Set(
      all
        .sort((a, b) => b.c.seenAt.localeCompare(a.c.seenAt))
        .slice(0, MAX_SURVEY_CARDS)
        .map((x) => `${x.key}|${x.c.id}`),
    );
    for (const s of live) s.cards = s.cards.filter((c) => keep.has(`${s.key}|${c.id}`));
  }
  return live.filter((s) => s.cards.length > 0);
}

/**
 * Fold a read of a results page into the same search's survey. Reading the SAME page again (same `scanUrl`) replaces the
 * survey's cards with what is on the page now, so nothing stale or off-page lingers. A different page of the same
 * search (next page, another sort or filter) is merged in, deduped by listing id (the newer card wins).
 */
export function mergeSurvey(
  surveys: SurveyRecord[],
  page: SearchPage,
  cards: SurveyCard[],
  now: number,
  scanUrl?: string,
): { surveys: SurveyRecord[]; survey: SurveyRecord | null; added: number } {
  const at = new Date(now).toISOString();
  const live = pruneSurveys(surveys.map((s) => ({ ...s, cards: [...s.cards] })), now);
  const existing = live.find((s) => s.key === page.key);
  const base: SurveyRecord = existing ?? { key: page.key, platform: page.platform, query: page.query, createdAt: at, updatedAt: at, cards: [] };
  const replace = !!scanUrl && base.scanUrl === scanUrl;
  const before = new Set(base.cards.map((c) => c.id));
  const byId = new Map((replace ? [] : base.cards).map((c) => [c.id, c]));
  let added = 0;
  for (const c of cards) {
    if (!before.has(c.id)) added++;
    byId.set(c.id, c);
  }
  const merged: SurveyRecord = { ...base, updatedAt: at, cards: [...byId.values()], ...(scanUrl ? { scanUrl } : {}) };
  const next = pruneSurveys([merged, ...live.filter((s) => s.key !== page.key)], now);
  return { surveys: next, survey: next.find((s) => s.key === page.key) ?? null, added };
}

/** The survey for the search the listing came from when it is known and still there, else the most recent on the platform. */
function latestSurvey(surveys: SurveyRecord[], args: { platform: string; now: number; searchKey?: string | null }): SurveyRecord | undefined {
  const live = pruneSurveys(surveys.map((s) => ({ ...s, cards: [...s.cards] })), args.now).filter((s) => s.platform === args.platform);
  return (args.searchKey ? live.find((s) => s.key === args.searchKey) : undefined) ?? live.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

/**
 * The survey to send with an investigation: the most recent unexpired one for the platform, without the listing being
 * investigated. Null when there is none.
 */
export function surveyForCase(
  surveys: SurveyRecord[],
  args: { platform: string; pageUrl: string; now: number; /** The search the listing came from, when known. */ searchKey?: string | null },
): { observedListings: SurveyCard[]; searchQuery?: string; survey: SurveyRecord } | null {
  if (args.platform !== "ebay" && args.platform !== "vinted") return null;
  const survey = latestSurvey(surveys, args);
  if (!survey) return null;
  const current = listingItemId(args.pageUrl, args.platform);
  const observedListings = survey.cards.filter((c) => c.id !== current).slice(0, MAX_OBSERVED_LISTINGS);
  if (!observedListings.length) return null;
  return { observedListings, ...(survey.query ? { searchQuery: survey.query } : {}), survey };
}

// ---------- top results for a case ----------

/** What the case file and the investigation view show under "Other high-potential results". */
export type TopResultsBlock = { results: TopResult[]; platformName: string; footnote: string | null };

/**
 * The best-value listings from the buyer's most recent search on the case's platform, never including the listing itself.
 * Null when there is no survey for that platform. Entirely local: it uses the survey kept on this device.
 */
export function topResultsForCase(
  surveys: SurveyRecord[],
  args: { platform: string; pageUrl: string | null; profile: Profile | null; colourWish?: string; now: number; searchKey?: string | null },
): TopResultsBlock | null {
  if (args.platform !== "ebay" && args.platform !== "vinted") return null;
  const survey = latestSurvey(surveys, args);
  if (!survey) return null;
  const results = topResults(survey.cards, { profile: args.profile, query: survey.query, excludeId: args.pageUrl ? listingItemId(args.pageUrl, args.platform) : null, colourWish: args.colourWish });
  if (!results.length) return null;
  const date = new Date(survey.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return {
    results,
    platformName: args.platform === "ebay" ? "eBay" : "Vinted",
    footnote: `From your ${args.platform === "ebay" ? "eBay" : "Vinted"} search${survey.query ? ` for “${survey.query}”` : ""} on ${date}. Best value first; none has been investigated.`,
  };
}

// ---------- the summary ----------

const catalogue = z.array(CatalogueModelSchema).parse(catalogueJson);
const sizeCharts = z.array(SizeChartSchema).parse(sizeChartsJson);
const CATALOGUE_TOKENS: ModelTokens[] = catalogue.map(catalogueTokens);
const BRANDS = [...new Set([...catalogue.map((m) => m.brand), ...sizeCharts.map((c) => c.brand)])];

/** The search query as a model, when it starts with (or contains) a known brand: "nike pegasus 40" -> Nike / Pegasus 40. */
export function queryModel(query: string): ModelTokens | null {
  const words = normaliseTitle(query).split(" ").filter(Boolean);
  const brand = BRANDS.find((b) => words.includes(brandToken(b)));
  if (!brand) return null;
  const rest = words.filter((w) => w !== brandToken(brand)).join(" ");
  return rest ? deriveTokens(brand, rest) : null;
}

const brandOf = (title: string) => {
  const words = normaliseTitle(title).split(" ");
  return BRANDS.find((b) => words.includes(brandToken(b))) ?? null;
};

export type SurveySummary = { total: number; inYourSize: number | null; unmatched: number };

/** What the profile says about the buyer's sizes, in the shape `userSizeUK` reads. */
function sizeNeeds(profile: Profile | null) {
  const sizes = profile?.sizes ?? [];
  const d = profile?.defaultSize;
  return {
    sizes: sizes.map((s) => ({ brand: s.brand, size: s.size, system: s.system ?? ("UK" as const) })),
    ...(d ? { defaultSize: { size: d.size, system: d.system ?? ("UK" as const) } } : {}),
  };
}

/**
 * A card's size in UK, and the buyer's UK size for that card's brand (null when the buyer has no sizes, or the brand or
 * size can't be read). `fits` is true only when both are known and equal.
 */
export function cardSizeFit(card: Pick<SurveyCard, "title" | "sizeText">, profile: Profile | null): { cardUK: number | null; mineUK: number | null; fits: boolean } {
  const sizes = profile?.sizes ?? [];
  const d = profile?.defaultSize;
  const brand = brandOf(card.title) ?? (d ? null : (sizes[0]?.brand ?? null));
  const chart = chartForBrand(brand, sizeCharts);
  const s = extractSize(card.sizeText, { bareOk: true }) ?? extractSize(card.title);
  const cardUK = s ? toUK(s, chart) : null;
  const mineUK = brand || d ? userSizeUK(sizeNeeds(profile), brand, chart, sizeCharts) : null;
  return { cardUK, mineUK, fits: cardUK !== null && mineUK !== null && Math.abs(cardUK - mineUK) < 0.01 };
}

/** Counts for "Surveyed 38 listings · 21 in your size · 6 couldn't be matched to a model yet". */
export function summariseSurvey(survey: Pick<SurveyRecord, "cards" | "query">, profile: Profile | null): SurveySummary {
  const models = [...CATALOGUE_TOKENS, ...(queryModel(survey.query) ? [queryModel(survey.query)!] : [])];
  const hasSizes = !!(profile?.sizes.length || profile?.defaultSize);
  const inSize = survey.cards.filter((c) => cardSizeFit(c, profile).fits).length;
  return {
    total: survey.cards.length,
    inYourSize: hasSizes ? inSize : null,
    unmatched: survey.cards.filter((c) => !namesAnyModel(c.title, models)).length,
  };
}

export function summaryLine(s: SurveySummary): string {
  return [
    `Surveyed ${s.total} listing${s.total === 1 ? "" : "s"}`,
    s.inYourSize !== null ? `${s.inYourSize} in your size` : null,
    `${s.unmatched} couldn't be matched to a model yet`,
  ]
    .filter(Boolean)
    .join(" · ");
}
