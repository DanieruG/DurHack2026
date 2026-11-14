import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig, type Config } from "@/lib/config";
import { ResponseCache } from "@/lib/cache";
import { sha256 } from "@/lib/hash";
import { loadSeedFiles } from "@/lib/seedData";
import { MemoryStore, type Store } from "@/lib/store";
import { safeFetchImage, type FetchedImage, type ImageFetcher, type ImageMime } from "@/lib/safeFetch";
import { RateLimiter } from "@/lib/rateLimit";
import { sniffImageMime, type StoredImage } from "@/lib/images";
import { createGeminiClient, createLiveTransport, type GeminiClient } from "@/gemini/client";
import { createNewPriceClient, type NewPriceClient } from "@/lib/newPrices";
import { createWebSearchClient, type WebSearchClient } from "@/lib/webSearch";
import { EventHub } from "./events";

export type Deps = {
  config: Config;
  store: Store;
  gemini: GeminiClient;
  /** Google Shopping new prices (price Source B), cached in CacheEntry. */
  newPrices: NewPriceClient;
  /** SerpApi web search for comfort reviews, cached in CacheEntry for 7 days. */
  webSearch: WebSearchClient;
  hub: EventHub;
  fetchImage: ImageFetcher;
  /** Catalogue reference images (data/images/catalogue/<file>). */
  readReferenceImage: (relPath: string) => Promise<StoredImage | null>;
  limiter: { create: RateLimiter; reopen: RateLimiter };
  now: () => Date;
};

export async function readReferenceImageFromDisk(relPath: string): Promise<StoredImage | null> {
  const base = path.join(process.cwd(), "data", "images", "catalogue");
  const full = path.resolve(base, relPath.replace(/^\/?(data\/images\/catalogue\/)?/, ""));
  if (!full.startsWith(base + path.sep)) return null;
  try {
    const bytes = new Uint8Array(await fs.readFile(full));
    const mimeType = sniffImageMime(bytes);
    return mimeType ? { bytes, mimeType } : null;
  } catch {
    return null;
  }
}

/** Image downloads go through the record/replay cache too, so a replayed demo needs no network. */
export function cachedFetcher(inner: ImageFetcher, cache: ResponseCache): ImageFetcher {
  if (!cache.enabled) return inner;
  return async (url) => {
    const key = sha256(url);
    const hit = await cache.get<{ b64: string; mimeType: ImageMime }>("images", key);
    if (hit) return { bytes: new Uint8Array(Buffer.from(hit.b64, "base64")), mimeType: hit.mimeType, sourceUrl: url };
    const img: FetchedImage = await inner(url);
    await cache.set("images", key, { b64: Buffer.from(img.bytes).toString("base64"), mimeType: img.mimeType });
    return img;
  };
}

async function createStore(config: Config): Promise<Store> {
  if (config.databaseUrl) {
    const [{ getDb }, { PrismaStore }] = await Promise.all([import("@/lib/db"), import("@/lib/prismaStore")]);
    return new PrismaStore(getDb(config.databaseUrl));
  }
  console.warn("[sleuth] DATABASE_URL not set: using the in-memory store seeded from /data (not persistent).");
  let seed: ReturnType<typeof loadSeedFiles> | null = null;
  return new MemoryStore(() => (seed ??= loadSeedFiles()));
}

async function buildDefaultDeps(): Promise<Deps> {
  const config = loadConfig();
  const store = await createStore(config);
  const cache = new ResponseCache(config.cacheMode, store);
  return {
    config,
    store,
    gemini: createGeminiClient({ config, transport: createLiveTransport(config.geminiApiKey), cache }),
    newPrices: createNewPriceClient({ apiKey: config.shoppingApiKey, mode: config.cacheMode, store }),
    webSearch: createWebSearchClient({ apiKey: config.shoppingApiKey, mode: config.cacheMode, store }),
    hub: new EventHub(),
    fetchImage: cachedFetcher((url) => safeFetchImage(url, { maxBytes: config.maxImageBytes }), cache),
    readReferenceImage: readReferenceImageFromDisk,
    limiter: { create: new RateLimiter(20, 60 * 60_000), reopen: new RateLimiter(40, 60 * 60_000) },
    now: () => new Date(),
  };
}

// Next.js may load route modules separately; keep one instance per process on globalThis.
const g = globalThis as unknown as { __sleuthDeps?: Promise<Deps> };

export function getDeps(): Promise<Deps> {
  return (g.__sleuthDeps ??= buildDefaultDeps());
}

/** Tests: install a deps bundle (mock Gemini, memory store). */
export function setDeps(deps: Deps | null): void {
  g.__sleuthDeps = deps ? Promise.resolve(deps) : undefined;
}
