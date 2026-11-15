import { sha256 } from "./hash";
import type { CacheMode } from "./cache";
import type { Store } from "./store";
import { recordSerpCall } from "./serpQuota";

/**
 * Google Lens visual matches via SerpApi (engine=google_lens, type=visual_matches), for listings whose model isn't clear.
 * Only the image's public URL is sent (never its bytes or anything about the listing's seller). Matches are other
 * pages' titles for look-alike shoes: evidence for identification, never facts. Cached per image URL; in replay mode any
 * cached answer is served and a miss throws, so a recorded demo makes no network calls.
 */

export const LENS_PROVIDER = "serpapi";
export const LENS_TIMEOUT_MS = 12_000;
export const LENS_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Visual matches kept per image. */
export const LENS_TOP = 6;

export type LensMatch = { title: string; source: string | null; link: string };

export type LensResponse = {
  matches: LensMatch[];
  /** YYYY-MM-DD of the live fetch (older when served from the cache). */
  fetchedOn: string;
  fromCache: boolean;
};

export class LensError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "LensError";
  }
}

type RawVisualMatch = { title?: string; link?: string; source?: string };

export type LensFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type LensClientOptions = {
  apiKey?: string;
  mode: CacheMode;
  store: Pick<Store, "cacheGet" | "cacheSet"> | null;
  fetch?: LensFetch;
  now?: () => Date;
  logger?: (line: string) => void;
  timeoutMs?: number;
  retryBackoffMs?: number;
};

export type LensClient = {
  /** Visual matches for a public image URL. Throws LensError on failure; no matches is not a failure. */
  visualMatches(imageUrl: string, opts?: { signal?: AbortSignal }): Promise<LensResponse>;
};

export function lensCacheKey(imageUrl: string): string {
  return `lens:${LENS_PROVIDER}:${sha256(imageUrl)}`;
}

/** Keep usable matches (a title and an http(s) link), unique by link, in SerpApi's order. */
export function topMatches(raw: RawVisualMatch[], top = LENS_TOP): LensMatch[] {
  const seen = new Set<string>();
  const out: LensMatch[] = [];
  for (const r of raw) {
    const link = r.link?.trim();
    const title = r.title?.replace(/\s+/g, " ").trim();
    if (!link || !title || !/^https?:\/\//i.test(link) || seen.has(link)) continue;
    seen.add(link);
    out.push({ title: title.slice(0, 200), source: r.source?.trim() || null, link });
    if (out.length >= top) break;
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const retryable = (status: number) => status === 429 || status >= 500;

type Cached = { fetchedAt: string; matches: LensMatch[] };

export function createLensClient(opts: LensClientOptions): LensClient {
  const now = opts.now ?? (() => new Date());
  const log = opts.logger ?? ((line: string) => (process.env.VITEST ? undefined : console.info(line)));
  const doFetch: LensFetch = opts.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = opts.timeoutMs ?? LENS_TIMEOUT_MS;

  async function live(imageUrl: string, outer?: AbortSignal): Promise<LensMatch[]> {
    if (!opts.apiKey) throw new LensError("SerpApi key (SHOPPING_API_KEY) is not set");
    if (!/^https?:\/\//i.test(imageUrl)) throw new LensError("not a public image URL");
    const u = new URL("https://serpapi.com/search.json");
    for (const [k, v] of Object.entries({ engine: "google_lens", url: imageUrl, type: "visual_matches", hl: "en", country: "uk" })) u.searchParams.set(k, v);
    u.searchParams.set("api_key", opts.apiKey); // never log `u`
    for (let attempt = 0; ; attempt++) {
      let res: Awaited<ReturnType<LensFetch>>;
      const signal = outer ? AbortSignal.any([outer, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      try {
        res = await doFetch(u.toString(), { signal });
      } catch (err) {
        throw new LensError(err instanceof Error && err.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : "request failed");
      }
      if (res.ok) {
        const body = (await res.json()) as { visual_matches?: RawVisualMatch[]; error?: string };
        if (body.error && !body.visual_matches) {
          if (/hasn't returned any results/i.test(body.error)) return [];
          throw new LensError(`provider error: ${body.error}`, res.status);
        }
        return topMatches(body.visual_matches ?? []);
      }
      if (attempt === 0 && retryable(res.status)) {
        await sleep(opts.retryBackoffMs ?? 600);
        continue;
      }
      throw new LensError(`HTTP ${res.status}`, res.status);
    }
  }

  return {
    async visualMatches(imageUrl, extra = {}) {
      const key = lensCacheKey(imageUrl);
      let cached: Cached | undefined;
      try {
        cached = (await opts.store?.cacheGet(key)) as Cached | undefined;
      } catch {
        cached = undefined;
      }
      const fresh = cached && now().getTime() - Date.parse(cached.fetchedAt) < LENS_CACHE_TTL_MS;
      if (cached && (fresh || opts.mode === "replay")) return { matches: cached.matches, fetchedOn: cached.fetchedAt.slice(0, 10), fromCache: true };
      if (opts.mode === "replay") throw new LensError("replay mode: no cached Lens result for this image");
      const started = Date.now();
      const matches = await live(imageUrl, extra.signal);
      log(`[lens] provider=${LENS_PROVIDER} matches=${matches.length} ${Date.now() - started}ms ${recordSerpCall("lens")}`);
      // An image with no matches stays that way, so that is cached too: no quota is spent asking again.
      try {
        await opts.store?.cacheSet(key, { fetchedAt: now().toISOString(), matches } satisfies Cached);
      } catch {
        /* cache is best effort */
      }
      return { matches, fetchedOn: now().toISOString().slice(0, 10), fromCache: false };
    },
  };
}
