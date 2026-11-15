import { analysePixels, type ColourShare } from "@/lib/colourCore";
import { colourWordsIn } from "@/lib/colourWords";
import { shortHash } from "./hash";
import type { PhotoReading, TopResult } from "./topResults";

/**
 * Colour from a few listing thumbnails, for the cards whose title names no colour. A cascade, so 100+ cards stay cheap:
 * titles are read first (instant), and only the best-value candidates still unknown get their photo looked at, a few at a
 * time, with a short time budget. Everything unread stays "colour not confirmed": it is never a reason to hide a listing.
 * Photo colour is soft evidence (white shoes read grey in shade), so topResults weights it below a title.
 */

export const MAX_THUMBNAILS = 24;
export const THUMB_CONCURRENCY = 6;
export const THUMB_BUDGET_MS = 3000;
export const THUMB_TIMEOUT_MS = 3000;
/** The analysis size: enough to see the shoe's colours, small enough to be quick. */
export const THUMB_PX = 64;

export type ThumbCandidate = { id: string; url: string };

/** A cached reading: which image it was read from, so a changed photo is read again. */
export type ThumbCacheEntry = { u: string; c: [string, number][]; m: boolean; t: number };
export type ThumbCache = Record<string, ThumbCacheEntry>;

export type ThumbDeps = {
  fetchBlob: (url: string, signal: AbortSignal) => Promise<Blob>;
  /** RGB(A) pixels of the image, downscaled to about THUMB_PX wide. */
  decode: (blob: Blob) => Promise<{ data: ArrayLike<number>; width: number; height: number; channels: number }>;
  now?: () => number;
};

/** eBay thumbnails come in sizes named in the path; ask for a small one. Vinted's size is part of its signature: leave it. */
export function smallThumbUrl(url: string): string {
  try {
    const u = new URL(url);
    if (/(^|\.)ebayimg\.com$/.test(u.hostname)) return url.replace(/\/s-l\d+(\.\w+)(\?.*)?$/, "/s-l140$1$2");
  } catch {
    /* not a URL: leave it */
  }
  return url;
}

const hashOf = (url: string) => shortHash(url).slice(0, 12);

export const toReading = (e: ThumbCacheEntry): PhotoReading => ({ colours: e.c.map(([name, share]) => ({ name, share })), multi: e.m });

/**
 * The cards worth a photo: otherwise good candidates (already ranked), whose title names no colour, that haven't been read.
 * Only when the buyer named a colour at all: a pure "look" wish can't be read from pixels.
 */
export function thumbCandidates(ranked: TopResult[], wishNamesColour: boolean, have: Record<string, unknown>, max = MAX_THUMBNAILS): ThumbCandidate[] {
  if (!wishNamesColour) return [];
  return ranked
    .filter((r) => r.card.thumbnailUrl && !colourWordsIn(r.card.title).length && !(r.card.id in have))
    .slice(0, max)
    .map((r) => ({ id: r.card.id, url: r.card.thumbnailUrl! }));
}

/**
 * Read the candidates' thumbnails, at most THUMB_CONCURRENCY at a time, stopping to start new ones after the budget.
 * Cached readings are used without a request. Calls onReading as each finishes, so the ranking can update as it goes.
 * Never throws: a thumbnail that can't be fetched or decoded is simply not read.
 */
export async function readThumbnails(
  candidates: ThumbCandidate[],
  cache: ThumbCache,
  deps: ThumbDeps,
  opts: { concurrency?: number; budgetMs?: number; timeoutMs?: number; onReading?: (id: string, reading: PhotoReading, entry: ThumbCacheEntry) => void; signal?: AbortSignal } = {},
): Promise<{ read: number; cached: number; failed: number; skipped: number }> {
  const now = deps.now ?? Date.now;
  const started = now();
  const budget = opts.budgetMs ?? THUMB_BUDGET_MS;
  const stats = { read: 0, cached: 0, failed: 0, skipped: 0 };
  const queue: ThumbCandidate[] = [];
  for (const c of candidates) {
    const hit = cache[c.id];
    if (hit && hit.u === hashOf(c.url)) {
      stats.cached++;
      opts.onReading?.(c.id, toReading(hit), hit);
    } else queue.push(c);
  }

  const one = async (c: ThumbCandidate) => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? THUMB_TIMEOUT_MS);
    const onAbort = () => ctl.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // Raced against the timeout as well, so a fetch that ignores its signal still can't hold a slot.
      const timedOut = new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true }));
      const blob = await Promise.race([deps.fetchBlob(smallThumbUrl(c.url), ctl.signal), timedOut]);
      const px = await deps.decode(blob);
      const a = analysePixels(px.data, px.width, px.height, px.channels);
      const entry: ThumbCacheEntry = { u: hashOf(c.url), c: a.colours.map((x: ColourShare) => [x.name, x.share]), m: a.multi, t: now() };
      cache[c.id] = entry;
      stats.read++;
      opts.onReading?.(c.id, toReading(entry), entry);
    } catch {
      stats.failed++;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < queue.length && !opts.signal?.aborted) {
      if (now() - started >= budget) {
        stats.skipped = queue.length - next;
        return;
      }
      await one(queue[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? THUMB_CONCURRENCY, queue.length) }, worker));
  return stats;
}

/** The browser's way of fetching and decoding a thumbnail (panel only). */
export const browserThumbDeps: ThumbDeps = {
  fetchBlob: async (url, signal) => {
    const res = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer", signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.blob();
  },
  decode: async (blob) => {
    const bmp = await createImageBitmap(blob, { resizeWidth: THUMB_PX, resizeQuality: "low" });
    try {
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no canvas");
      ctx.drawImage(bmp, 0, 0);
      const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
      return { data: img.data, width: img.width, height: img.height, channels: 4 };
    } finally {
      bmp.close();
    }
  },
};

/** Keep only entries for cards still in a survey, and not older than the survey TTL. */
export function pruneThumbCache(cache: ThumbCache, keepIds: Set<string>, now: number, ttlMs: number): ThumbCache {
  return Object.fromEntries(Object.entries(cache).filter(([id, e]) => keepIds.has(id) && now - e.t <= ttlMs));
}
