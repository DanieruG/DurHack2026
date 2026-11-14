import { sha256 } from "./hash";
import type { CacheMode } from "./cache";
import type { Store } from "./store";

/**
 * Google web search via SerpApi (engine=google), UK results. Used by the comfort check instead of Gemini's built-in
 * Google Search tool: we take the top organic results and hand their titles, links and snippets to Gemini as plain text.
 * Responses are cached in CacheEntry per query for 7 days (served from the cache without any network call in replay mode).
 */

export const WEB_SEARCH_PROVIDER = "serpapi";
export const WEB_SEARCH_GL = "uk";
export const WEB_SEARCH_TIMEOUT_MS = 8_000;
export const WEB_SEARCH_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const WEB_SEARCH_TOP = 6;

/**
 * One organic result: its 1-based position in our list, plus what SerpApi gives us. `domain` is the site's own host:
 * SerpApi's `link` is often an opaque Google redirect (google.com/goto?url=...), so the host comes from `displayed_link`.
 * It is "" when no site host can be found.
 */
export type WebResult = { index: number; title: string; link: string; domain: string; snippet: string; source?: string };

export type WebSearchResponse = {
  query: string;
  results: WebResult[];
  /** YYYY-MM-DD of the live fetch (older than today when served from the cache). */
  fetchedOn: string;
  fromCache: boolean;
};

export class WebSearchError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "WebSearchError";
  }
}

/** The subset of a SerpApi organic result we use (and cache). */
type RawOrganic = { position?: number; title?: string; link?: string; displayed_link?: string; snippet?: string; source?: string };

const HOST = /^(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})(?=$|[\s/›:?#])/i;
const GOOGLE_REDIRECT = /(^|\.)google\.[a-z.]+$/i;

function hostOf(s: string | undefined): string {
  const m = s ? HOST.exec(s.trim()) : null;
  return m ? m[1].toLowerCase().replace(/^www\./, "") : "";
}

/** The result's own site: its link's host, unless that is a Google redirect; then the displayed link, then `source`. */
export function resultDomain(r: Pick<RawOrganic, "link" | "displayed_link" | "source">): string {
  const linkHost = hostOf(r.link);
  if (linkHost && !GOOGLE_REDIRECT.test(linkHost)) return linkHost;
  return hostOf(r.displayed_link) || hostOf(r.source);
}

export type WebSearchFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type WebSearchClientOptions = {
  apiKey?: string;
  mode: CacheMode;
  store: Pick<Store, "cacheGet" | "cacheSet"> | null;
  fetch?: WebSearchFetch;
  now?: () => Date;
  logger?: (line: string) => void;
  timeoutMs?: number;
  retryBackoffMs?: number;
};

export type WebSearchClient = {
  /** Top WEB_SEARCH_TOP organic results. Throws WebSearchError on failure; an empty list is not a failure. */
  search(query: string, opts?: { signal?: AbortSignal }): Promise<WebSearchResponse>;
};

type CachedResponse = { fetchedAt: string; results: WebResult[] };

export function comfortQuery(brand: string, modelName: string): string {
  return `${brand} ${modelName} review comfort`.replace(/\s+/g, " ").trim();
}

export function webSearchCacheKey(query: string, gl = WEB_SEARCH_GL): string {
  return `websearch:${WEB_SEARCH_PROVIDER}:${gl}:${sha256(query.toLowerCase())}`;
}

/** Keep usable organic results (http(s) link, a title), in rank order, renumbered 1..n, at most `top`. */
export function topOrganic(raw: RawOrganic[], top = WEB_SEARCH_TOP): WebResult[] {
  const seen = new Set<string>();
  const out: WebResult[] = [];
  const ranked = [...raw].sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  for (const r of ranked) {
    const link = r.link?.trim();
    const title = r.title?.trim();
    if (!link || !title || !/^https?:\/\//i.test(link) || seen.has(link)) continue;
    seen.add(link);
    out.push({ index: out.length + 1, title, link, domain: resultDomain(r), snippet: (r.snippet ?? "").replace(/\s+/g, " ").trim(), ...(r.source ? { source: r.source } : {}) });
    if (out.length >= top) break;
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (status: number) => status === 429 || status >= 500;

export function createWebSearchClient(opts: WebSearchClientOptions): WebSearchClient {
  const now = opts.now ?? (() => new Date());
  const log = opts.logger ?? ((line: string) => (process.env.VITEST ? undefined : console.info(line)));
  const doFetch: WebSearchFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS;

  async function live(query: string, outer?: AbortSignal): Promise<WebResult[]> {
    if (!opts.apiKey) throw new WebSearchError("SerpApi key (SHOPPING_API_KEY) is not set");
    const u = new URL("https://serpapi.com/search.json");
    for (const [k, v] of Object.entries({ engine: "google", q: query, gl: WEB_SEARCH_GL, hl: "en", google_domain: "google.co.uk", num: "10" })) u.searchParams.set(k, v);
    u.searchParams.set("api_key", opts.apiKey); // never log `u`
    for (let attempt = 0; ; attempt++) {
      let res: Awaited<ReturnType<WebSearchFetch>>;
      const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      try {
        res = await doFetch(u.toString(), { signal });
      } catch (err) {
        throw new WebSearchError(err instanceof Error && err.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : "request failed");
      }
      if (res.ok) {
        const body = (await res.json()) as { organic_results?: RawOrganic[]; error?: string };
        if (body.error && !body.organic_results) {
          if (/hasn't returned any results/i.test(body.error)) return [];
          throw new WebSearchError(`provider error: ${body.error}`, res.status);
        }
        return topOrganic(body.organic_results ?? []);
      }
      if (attempt === 0 && retryable(res.status)) {
        await sleep(opts.retryBackoffMs ?? 600);
        continue;
      }
      throw new WebSearchError(`HTTP ${res.status}`, res.status);
    }
  }

  return {
    async search(query, extra = {}) {
      const key = webSearchCacheKey(query);
      let cached: CachedResponse | undefined;
      try {
        cached = (await opts.store?.cacheGet(key)) as CachedResponse | undefined;
      } catch {
        cached = undefined;
      }
      const fresh = cached && now().getTime() - Date.parse(cached.fetchedAt) < WEB_SEARCH_CACHE_TTL_MS;
      if (cached && (fresh || opts.mode === "replay")) {
        return { query, results: cached.results, fetchedOn: cached.fetchedAt.slice(0, 10), fromCache: true };
      }
      if (opts.mode === "replay") throw new WebSearchError(`replay mode: no cached web search for "${query}"`);
      const started = Date.now();
      const results = await live(query, extra.signal);
      log(`[websearch] provider=${WEB_SEARCH_PROVIDER} q="${query}" gl=${WEB_SEARCH_GL} results=${results.length} ${Date.now() - started}ms`);
      // Cache only non-empty answers: an empty page is more likely a transient miss than the truth for a week.
      if (results.length) {
        try {
          await opts.store?.cacheSet(key, { fetchedAt: now().toISOString(), results } satisfies CachedResponse);
        } catch {
          /* cache is best effort */
        }
      }
      return { query, results, fetchedOn: now().toISOString().slice(0, 10), fromCache: false };
    },
  };
}
