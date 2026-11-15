import { sha256 } from "./hash";
import type { CacheMode } from "./cache";
import type { Store } from "./store";
import type { NewOffer, NewOffers } from "@/schemas/domain";
import { hasStyleCode } from "./colourWords";
import { recordSerpCall } from "./serpQuota";

/**
 * Current new retail prices from Google Shopping (SerpApi), UK results in GBP.
 * Filtering is done here in code, never by Gemini. Responses are cached in CacheEntry for 24 hours (and served from the
 * cache without any network call in replay mode).
 */

export const SHOPPING_PROVIDER = "serpapi";
export const SHOPPING_GL = "uk";
export const SHOPPING_TIMEOUT_MS = 8_000;
export const SHOPPING_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_OFFERS = 3;

export type ColourMatch = "same" | "different" | "unknown";
export type ShoppingOffer = {
  retailer: string;
  priceGBP: number;
  url: string;
  title: string;
  thumbnailUrl?: string;
  /** Set by the price check once the listing's colour is known (pipeline/offerColour.ts). */
  colourMatch?: ColourMatch;
  colourEvidence?: string;
};

export type NewPrices = {
  offers: ShoppingOffer[];
  /** Median of the kept offers, or null when fewer than MIN_OFFERS matched (new price unavailable). */
  medianGBP: number | null;
  lowestGBP: number | null;
  checkedOn: string;
  available: boolean;
  query: string;
  /** Every Shopping query run, in order (style code or colour first, then the plain model query if needed). */
  queries?: string[];
  rawResults: number;
  /** True when served from the 24-hour cache (no SerpApi call). */
  fromCache?: boolean;
};

/** The subset of a SerpApi google_shopping result we use (and cache). */
export type RawShoppingResult = {
  title?: string;
  source?: string;
  price?: string;
  extracted_price?: number;
  product_link?: string;
  link?: string;
  thumbnail?: string;
  second_hand_condition?: string;
  tag?: string;
  extensions?: string[];
};

export class ShoppingError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "ShoppingError";
  }
}

// ---------- filtering (pure) ----------

// Second-hand marketplaces and resale platforms: their prices are not new retail prices.
const MARKETPLACE =
  /\b(ebay|vinted|depop|facebook|gumtree|vestiaire( collective)?|stockx|goat|laced|klekt|grailed|poshmark|mercari|preloved|shpock|thredup|alias|wallapop|backmarket|music magpie|cex)\b/i;
const USED = /\b(used|pre[- ]?owned|refurbished|second[- ]?hand|pre[- ]?loved|worn)\b/i;
const ACCESSORY =
  /\b(insoles?|laces?|shoelaces?|socks?|bundle|bundles|shoe (care|cleaner|bag|tree)s?|cleaner|cleaning kit|keyrings?|key ?chains?|replacement|box only|gift card|stickers?|charms?|decals?|protectors?|spikes only)\b/i;
const KIDS = /\b(kids?|kid's|children'?s?|child|junior|juniors|jr|youth|infants?|toddlers?|baby|babies|little kids|big kids|grade school|gs|ps|td)\b/i;

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Model-name tokens that must all appear in an offer title: words of 2+ characters and every number. */
export function significantTokens(modelName: string): string[] {
  return words(modelName).filter((t) => t.length >= 2 || /\d/.test(t));
}

/**
 * Title matches the brand and the exact model: every significant token present as a whole word, and each version number
 * directly after the word before it ("dropset 3" must not match "dropset 2", "dropset 3" must not match "dropset base ... 3").
 */
export function titleMatchesModel(title: string, brand: string, modelName: string): boolean {
  const t = words(title);
  const brandTokens = words(brand);
  if (!brandTokens.every((b) => t.includes(b))) return false;
  const tokens = significantTokens(modelName);
  if (!tokens.length || !tokens.every((x) => t.includes(x))) return false;
  for (let i = 1; i < tokens.length; i++) {
    if (!/^\d+$/.test(tokens[i])) continue;
    const prev = tokens[i - 1];
    const adjacent = t.some((w, j) => w === prev && t[j + 1] === tokens[i]);
    if (!adjacent) return false;
  }
  return true;
}

export function parseGBP(r: RawShoppingResult): number | null {
  const s = r.price ?? "";
  if (!/£/.test(s)) return null;
  const n = typeof r.extracted_price === "number" ? r.extracted_price : Number(s.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type FilterReason = "marketplace" | "used" | "model" | "accessory" | "kids" | "price";

/** Why a raw result is rejected, or null to keep it. */
export type FilterArgs = { brand: string; modelName: string; kids?: boolean; styleCode?: string };

export function rejectReason(r: RawShoppingResult, args: FilterArgs): FilterReason | null {
  const title = r.title ?? "";
  const seller = r.source ?? "";
  if (!seller || MARKETPLACE.test(seller)) return "marketplace";
  if (r.second_hand_condition || USED.test(title) || USED.test(r.tag ?? "") || (r.extensions ?? []).some((e) => USED.test(e))) return "used";
  // The exact model, or the listing's style code (which names the exact colourway).
  if (!titleMatchesModel(title, args.brand, args.modelName) && !hasStyleCode(title, args.styleCode)) return "model";
  if (ACCESSORY.test(title)) return "accessory";
  if (!args.kids && KIDS.test(title)) return "kids";
  if (parseGBP(r) === null) return "price";
  return null;
}

// ---------- links and thumbnails (pure) ----------

const isGoogleHost = (host: string) => /(^|\.)google\.[a-z.]+$/i.test(host);

const httpUrl = (s: string | undefined): URL | null => {
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
};

/** A google.*\/url?q=... or ?url=... redirect, unwrapped to the http(s) page it points at. */
function unwrapGoogleRedirect(u: URL): URL | null {
  if (!isGoogleHost(u.hostname) || u.pathname !== "/url") return null;
  const target = httpUrl(u.searchParams.get("url") ?? u.searchParams.get("q") ?? undefined);
  return target && !isGoogleHost(target.hostname) ? target : null;
}

/**
 * The link a card opens: the retailer's own product page when Shopping gives one (`link`, or a Google redirect to it),
 * else the Google Shopping page (`product_link`). Only http(s); "" when there is none.
 */
export function offerUrl(r: Pick<RawShoppingResult, "link" | "product_link">): string {
  const candidates = [r.link, r.product_link].map(httpUrl).filter((u): u is URL => !!u);
  const direct = candidates.find((u) => !isGoogleHost(u.hostname)) ?? candidates.map(unwrapGoogleRedirect).find((u): u is URL => !!u);
  return (direct ?? candidates[0])?.toString() ?? "";
}

/**
 * Shopping thumbnails are served from encrypted-tbn0..3.gstatic.com (checked against a live gl=uk response). Anything
 * else is dropped (the panel shows its placeholder), so the panel only ever loads images from these hosts.
 */
export const THUMBNAIL_HOST = /^encrypted-tbn[0-9]\.gstatic\.com$/;

export function offerThumbnail(url: string | undefined): string | undefined {
  const u = httpUrl(url);
  return u && u.protocol === "https:" && THUMBNAIL_HOST.test(u.hostname) ? u.toString() : undefined;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The offers the panel shows as cards: cheapest first, exactly one marked isLowest, each with its difference from the
 * listing price (negative = cheaper than the listing). Offers without an http(s) link are left out (nothing to open).
 * enoughForComparison mirrors the price rule (at least MIN_OFFERS kept); it never changes the verdict.
 */
const COLOUR_ORDER: Record<ColourMatch, number> = { same: 0, unknown: 1, different: 2 };

export function toNewOffers(
  r: Pick<NewPrices, "offers" | "checkedOn" | "queries">,
  listingPriceGBP: number,
  extra: { colourNote?: string | null } = {},
): NewOffers {
  const openable = r.offers.filter((o) => httpUrl(o.url));
  const lowest = Math.min(...openable.map((o) => o.priceGBP));
  // The listing's colour first, then by price.
  const sorted = openable
    .map((o, i) => ({ o, i }))
    .sort((a, b) => COLOUR_ORDER[a.o.colourMatch ?? "unknown"] - COLOUR_ORDER[b.o.colourMatch ?? "unknown"] || a.o.priceGBP - b.o.priceGBP || a.i - b.i)
    .map(({ o }) => o);
  let lowestMarked = false;
  const offers: NewOffer[] = sorted.map((o) => {
    const isLowest = !lowestMarked && o.priceGBP === lowest;
    if (isLowest) lowestMarked = true;
    return {
      retailer: o.retailer,
      title: o.title,
      priceGBP: o.priceGBP,
      url: o.url,
      ...(offerThumbnail(o.thumbnailUrl) ? { thumbnailUrl: offerThumbnail(o.thumbnailUrl) } : {}),
      differenceGBP: round2(o.priceGBP - listingPriceGBP),
      isLowest,
      colourMatch: o.colourMatch ?? "unknown",
      ...(o.colourEvidence ? { colourEvidence: o.colourEvidence } : {}),
    };
  });
  return {
    offers,
    checkedOn: r.checkedOn,
    enoughForComparison: r.offers.length >= MIN_OFFERS,
    ...(extra.colourNote ? { colourNote: extra.colourNote } : {}),
    ...(r.queries?.length ? { queries: r.queries } : {}),
  };
}

const retailerKey = (s: string) => s.toLowerCase().replace(/\b(uk|ire|ie|com|co uk|online|store|shop)\b/g, "").replace(/[^a-z0-9]+/g, "");

/** Keep retailer offers for exactly this model; one per retailer (its lowest price), cheapest first. */
export function filterOffers(results: RawShoppingResult[], args: FilterArgs): ShoppingOffer[] {
  const best = new Map<string, ShoppingOffer>();
  for (const r of results) {
    if (rejectReason(r, args)) continue;
    const priceGBP = parseGBP(r)!;
    const thumbnailUrl = offerThumbnail(r.thumbnail);
    const offer: ShoppingOffer = { retailer: r.source!.trim(), priceGBP, url: offerUrl(r), title: r.title!.trim(), ...(thumbnailUrl ? { thumbnailUrl } : {}) };
    const key = retailerKey(offer.retailer);
    const prev = best.get(key);
    if (!prev || priceGBP < prev.priceGBP) best.set(key, offer);
  }
  return [...best.values()].sort((a, b) => a.priceGBP - b.priceGBP);
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round(((s[mid - 1] + s[mid]) / 2) * 100) / 100;
}

export function summariseOffers(offers: ShoppingOffer[], meta: { checkedOn: string; query: string; rawResults: number; queries?: string[] }): NewPrices {
  const available = offers.length >= MIN_OFFERS;
  return {
    offers,
    medianGBP: available ? median(offers.map((o) => o.priceGBP)) : null,
    lowestGBP: available ? Math.min(...offers.map((o) => o.priceGBP)) : null,
    available,
    ...meta,
  };
}

// ---------- client (network + cache) ----------

export type ShoppingFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type NewPriceClientOptions = {
  apiKey?: string;
  mode: CacheMode;
  store: Pick<Store, "cacheGet" | "cacheSet"> | null;
  fetch?: ShoppingFetch;
  now?: () => Date;
  logger?: (line: string) => void;
  timeoutMs?: number;
  retryBackoffMs?: number;
};

type CachedResponse = { fetchedAt: string; results: RawShoppingResult[] };

export type NewPriceOptions = {
  kids?: boolean;
  /** The listing's main colour name, added to the query when there is no style code. */
  colour?: string;
  /** The listing's style code: searched first, as it targets the exact colourway. */
  styleCode?: string;
};

export type NewPriceClient = {
  getNewPrices(modelName: string, brand: string, opts?: NewPriceOptions): Promise<NewPrices>;
};

/** The queries to try, in order: style code, else model plus main colour; then the plain model query as a fallback. */
export function shoppingQueries(brand: string, modelName: string, opts: NewPriceOptions = {}): string[] {
  const plain = shoppingQuery(brand, modelName);
  const first = opts.styleCode ? `${brand} ${opts.styleCode}`.replace(/\s+/g, " ").trim() : opts.colour ? `${plain} ${opts.colour}` : plain;
  return first === plain ? [plain] : [first, plain];
}

export function shoppingQuery(brand: string, modelName: string): string {
  return `${brand} ${modelName}`.replace(/\s+/g, " ").trim();
}

export function shoppingCacheKey(query: string, gl = SHOPPING_GL): string {
  return `shopping:${SHOPPING_PROVIDER}:${gl}:${sha256(query.toLowerCase())}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (status: number) => status === 429 || status >= 500;

export function createNewPriceClient(opts: NewPriceClientOptions): NewPriceClient {
  const now = opts.now ?? (() => new Date());
  const log = opts.logger ?? ((line: string) => (process.env.VITEST ? undefined : console.info(line)));
  const doFetch: ShoppingFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? SHOPPING_TIMEOUT_MS;

  async function live(query: string): Promise<RawShoppingResult[]> {
    if (!opts.apiKey) throw new ShoppingError("SHOPPING_API_KEY is not set");
    const u = new URL("https://serpapi.com/search.json");
    for (const [k, v] of Object.entries({ engine: "google_shopping", q: query, gl: SHOPPING_GL, hl: "en", google_domain: "google.co.uk" })) u.searchParams.set(k, v);
    u.searchParams.set("api_key", opts.apiKey); // never log `u`
    for (let attempt = 0; ; attempt++) {
      let res: Awaited<ReturnType<ShoppingFetch>>;
      try {
        res = await doFetch(u.toString(), { signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        throw new ShoppingError(err instanceof Error && err.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : "request failed");
      }
      if (res.ok) {
        const body = (await res.json()) as { shopping_results?: RawShoppingResult[]; error?: string };
        if (body.error && !body.shopping_results) {
          // SerpApi reports "no results" as an error string; anything else is a real failure.
          if (/hasn't returned any results/i.test(body.error)) return [];
          throw new ShoppingError(`provider error: ${body.error}`, res.status);
        }
        return (body.shopping_results ?? []).map(pick);
      }
      if (attempt === 0 && retryable(res.status)) {
        await sleep(opts.retryBackoffMs ?? 600);
        continue;
      }
      throw new ShoppingError(`HTTP ${res.status}`, res.status);
    }
  }

  /** One query, through the 24-hour cache (served from it without a call in replay mode). */
  async function fetchQuery(query: string, filterArgs: FilterArgs, checkedOn: string): Promise<{ results: RawShoppingResult[]; fromCache: boolean; fetchedOn: string }> {
    const key = shoppingCacheKey(query);
    let cached: CachedResponse | undefined;
    try {
      cached = (await opts.store?.cacheGet(key)) as CachedResponse | undefined;
    } catch {
      cached = undefined;
    }
    const fresh = cached && now().getTime() - Date.parse(cached.fetchedAt) < SHOPPING_CACHE_TTL_MS;
    if (cached && (fresh || opts.mode === "replay")) return { results: cached.results, fromCache: true, fetchedOn: cached.fetchedAt.slice(0, 10) };
    if (opts.mode === "replay") throw new ShoppingError(`replay mode: no cached Shopping response for "${query}"`);
    const started = Date.now();
    const results = await live(query);
    log(`[shopping] provider=${SHOPPING_PROVIDER} q="${query}" gl=${SHOPPING_GL} raw=${results.length} kept=${filterOffers(results, filterArgs).length} ${Date.now() - started}ms ${recordSerpCall("shopping")}`);
    try {
      await opts.store?.cacheSet(key, { fetchedAt: now().toISOString(), results } satisfies CachedResponse);
    } catch {
      /* cache is best effort */
    }
    return { results, fromCache: false, fetchedOn: checkedOn };
  }

  return {
    async getNewPrices(modelName, brand, extra = {}) {
      const filterArgs = { brand, modelName, kids: extra.kids, styleCode: extra.styleCode };
      const queries = shoppingQueries(brand, modelName, extra);
      const checkedOn = now().toISOString().slice(0, 10);
      const ran: string[] = [];
      const raw: RawShoppingResult[] = [];
      let fetchedOn = checkedOn;
      let allCached = true;
      for (const query of queries) {
        // The fallback (plain model query) runs only when the targeted one kept too few offers.
        if (raw.length && filterOffers(raw, filterArgs).length >= MIN_OFFERS) break;
        let r: Awaited<ReturnType<typeof fetchQuery>>;
        try {
          r = await fetchQuery(query, filterArgs, checkedOn);
        } catch (err) {
          // A failed targeted query (style code / colour) still leaves the plain model query to try.
          if (query === queries.at(-1)) throw err;
          continue;
        }
        ran.push(query);
        raw.push(...r.results);
        if (!r.fromCache) allCached = false;
        if (r.fetchedOn < fetchedOn) fetchedOn = r.fetchedOn;
      }
      const seen = new Set<string>();
      const results = raw.filter((x) => {
        const k = `${x.source}|${x.title}|${x.price}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
      return { ...summariseOffers(filterOffers(results, filterArgs), { checkedOn: fetchedOn, query: ran[0], queries: ran, rawResults: results.length }), fromCache: allCached };
    },
  };
}

function pick(r: RawShoppingResult): RawShoppingResult {
  const { title, source, price, extracted_price, product_link, link, thumbnail, second_hand_condition, tag, extensions } = r;
  return { title, source, price, extracted_price, product_link, link, thumbnail, second_hand_condition, tag, extensions };
}

/** Convenience wrapper with the spec's signature; pass the client the app built (see pipeline/deps.ts). */
export function getNewPrices(modelName: string, brand: string, client: NewPriceClient, opts?: NewPriceOptions): Promise<NewPrices> {
  return client.getNewPrices(modelName, brand, opts);
}
