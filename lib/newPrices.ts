import { sha256 } from "./hash";
import type { CacheMode } from "./cache";
import type { Store } from "./store";

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

export type ShoppingOffer = { retailer: string; priceGBP: number; url: string; title: string };

export type NewPrices = {
  offers: ShoppingOffer[];
  /** Median of the kept offers, or null when fewer than MIN_OFFERS matched (new price unavailable). */
  medianGBP: number | null;
  lowestGBP: number | null;
  checkedOn: string;
  available: boolean;
  query: string;
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
export function rejectReason(r: RawShoppingResult, args: { brand: string; modelName: string; kids?: boolean }): FilterReason | null {
  const title = r.title ?? "";
  const seller = r.source ?? "";
  if (!seller || MARKETPLACE.test(seller)) return "marketplace";
  if (r.second_hand_condition || USED.test(title) || USED.test(r.tag ?? "") || (r.extensions ?? []).some((e) => USED.test(e))) return "used";
  if (!titleMatchesModel(title, args.brand, args.modelName)) return "model";
  if (ACCESSORY.test(title)) return "accessory";
  if (!args.kids && KIDS.test(title)) return "kids";
  if (parseGBP(r) === null) return "price";
  return null;
}

const retailerKey = (s: string) => s.toLowerCase().replace(/\b(uk|ire|ie|com|co uk|online|store|shop)\b/g, "").replace(/[^a-z0-9]+/g, "");

/** Keep retailer offers for exactly this model; one per retailer (its lowest price), cheapest first. */
export function filterOffers(results: RawShoppingResult[], args: { brand: string; modelName: string; kids?: boolean }): ShoppingOffer[] {
  const best = new Map<string, ShoppingOffer>();
  for (const r of results) {
    if (rejectReason(r, args)) continue;
    const priceGBP = parseGBP(r)!;
    const offer: ShoppingOffer = { retailer: r.source!.trim(), priceGBP, url: r.product_link ?? r.link ?? "", title: r.title!.trim() };
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

export function summariseOffers(offers: ShoppingOffer[], meta: { checkedOn: string; query: string; rawResults: number }): NewPrices {
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

export type NewPriceClient = {
  getNewPrices(modelName: string, brand: string, opts?: { kids?: boolean }): Promise<NewPrices>;
};

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

  return {
    async getNewPrices(modelName, brand, extra = {}) {
      const query = shoppingQuery(brand, modelName);
      const key = shoppingCacheKey(query);
      const checkedOn = now().toISOString().slice(0, 10);
      let cached: CachedResponse | undefined;
      try {
        cached = (await opts.store?.cacheGet(key)) as CachedResponse | undefined;
      } catch {
        cached = undefined;
      }
      const fresh = cached && now().getTime() - Date.parse(cached.fetchedAt) < SHOPPING_CACHE_TTL_MS;
      let results: RawShoppingResult[];
      let fetchedOn = checkedOn;
      if (cached && (fresh || opts.mode === "replay")) {
        results = cached.results;
        fetchedOn = cached.fetchedAt.slice(0, 10);
      } else if (opts.mode === "replay") {
        throw new ShoppingError(`replay mode: no cached Shopping response for "${query}"`);
      } else {
        const started = Date.now();
        results = await live(query);
        const offers = filterOffers(results, { brand, modelName, ...extra });
        log(`[shopping] provider=${SHOPPING_PROVIDER} q="${query}" gl=${SHOPPING_GL} raw=${results.length} kept=${offers.length} ${Date.now() - started}ms`);
        try {
          await opts.store?.cacheSet(key, { fetchedAt: now().toISOString(), results } satisfies CachedResponse);
        } catch {
          /* cache is best effort */
        }
      }
      const fromCache = !!cached && (fresh || opts.mode === "replay");
      return { ...summariseOffers(filterOffers(results, { brand, modelName, ...extra }), { checkedOn: fetchedOn, query, rawResults: results.length }), fromCache };
    },
  };
}

function pick(r: RawShoppingResult): RawShoppingResult {
  const { title, source, price, extracted_price, product_link, link, second_hand_condition, tag, extensions } = r;
  return { title, source, price, extracted_price, product_link, link, second_hand_condition, tag, extensions };
}

/** Convenience wrapper with the spec's signature; pass the client the app built (see pipeline/deps.ts). */
export function getNewPrices(modelName: string, brand: string, client: NewPriceClient, opts?: { kids?: boolean }): Promise<NewPrices> {
  return client.getNewPrices(modelName, brand, opts);
}
