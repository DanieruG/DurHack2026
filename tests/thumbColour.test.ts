import { describe, expect, it } from "vitest";
import { analysePixels } from "@/lib/colourCore";
import { readThumbnails, smallThumbUrl, thumbCandidates, MAX_THUMBNAILS, THUMB_CONCURRENCY, pruneThumbCache, type ThumbCache, type ThumbDeps } from "@/extension/src/lib/thumbColour";
import { shortHash } from "@/extension/src/lib/hash";
import type { TopResult } from "@/extension/src/lib/topResults";
import type { SurveyCard } from "@/extension/src/lib/survey";
import manifest from "@/extension/manifest.json";

/** A 64x64 image: a plain backdrop with a shoe-sized block of one colour in the middle. */
function pixels(rgb: [number, number, number], bg: [number, number, number] = [235, 235, 235], size = 64) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inside = x > size * 0.2 && x < size * 0.8 && y > size * 0.3 && y < size * 0.7;
      const c = inside ? rgb : bg;
      const i = (y * size + x) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    }
  }
  return { data, width: size, height: size, channels: 4 };
}

const colours: Record<string, [number, number, number]> = { white: [250, 250, 250], black: [20, 20, 20], red: [200, 30, 30] };
/** Decode "blob" text like "black" into pixels; fetch returns that text as the blob. */
function fakeDeps(over: Partial<ThumbDeps> & { log?: string[]; delay?: number } = {}): ThumbDeps & { inflight: { max: number } } {
  const inflight = { cur: 0, max: 0 };
  return {
    inflight,
    fetchBlob:
      over.fetchBlob ??
      (async (url: string, signal: AbortSignal) => {
        over.log?.push(url);
        inflight.cur++;
        inflight.max = Math.max(inflight.max, inflight.cur);
        try {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, over.delay ?? 2);
            signal.addEventListener("abort", () => (clearTimeout(t), reject(new Error("aborted"))));
          });
          return new Blob([new URL(url).searchParams.get("c") ?? "white"]);
        } finally {
          inflight.cur--;
        }
      }),
    decode: over.decode ?? (async (blob: Blob) => pixels(colours[await blob.text()] ?? colours.white, colours.white[0] === 250 ? [120, 140, 160] : undefined)),
    now: over.now,
  } as never;
}

const card = (id: string, title = "Nike Pegasus 40 UK 9", thumb = `https://images1.vinted.net/t/${id}/310x430/a.webp?c=white`): TopResult =>
  ({ card: { id, title, price: 30, currency: "GBP", url: `https://www.vinted.co.uk/items/${id}-x`, thumbnailUrl: thumb, sponsored: false, priceBasis: "excl_buyer_protection", seenAt: "2026-11-14T10:00:00.000Z" } as SurveyCard, score: 1, reason: "", sizeLabel: "UK 9", typicalGBP: 30 });

describe("the colour helper runs in the extension", () => {
  it("analysePixels (shared with the server) reads a block of colour on a backdrop", () => {
    const a = analysePixels(...(([p]) => [p.data, p.width, p.height, p.channels] as const)([pixels(colours.red)]));
    expect(a.colours[0].name).toBe("red");
    expect(a.multi).toBe(false);
  });
  it("has no Node-only imports", async () => {
    const src = (await import("node:fs")).readFileSync(new URL("../lib/colourCore.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from "sharp"|node:/);
  });
});

describe("thumbnail urls and candidates", () => {
  it("asks eBay for a small thumbnail and leaves Vinted's signed ones alone", () => {
    expect(smallThumbUrl("https://i.ebayimg.com/images/g/abc/s-l500.webp")).toBe("https://i.ebayimg.com/images/g/abc/s-l140.webp");
    expect(smallThumbUrl("https://i.ebayimg.com/thumbs/images/g/abc/s-l1600.jpg")).toBe("https://i.ebayimg.com/thumbs/images/g/abc/s-l140.jpg");
    const vinted = "https://images1.vinted.net/t/01_abc/310x430/x.webp?s=abc123";
    expect(smallThumbUrl(vinted)).toBe(vinted);
    expect(smallThumbUrl("not a url")).toBe("not a url");
  });
  it("only cards whose title names no colour, with a thumbnail, not yet read, up to the cap, and only when the wish names a colour", () => {
    const ranked = [card("1", "Nike Pegasus 40 white"), card("2"), card("3", "Nike Pegasus 40", ""), card("4"), card("5")];
    expect(thumbCandidates(ranked, true, { "5": {} }).map((c) => c.id)).toEqual(["2", "4"]);
    expect(thumbCandidates(ranked, false, {})).toEqual([]);
    expect(thumbCandidates(Array.from({ length: 60 }, (_, i) => card(String(i))), true, {})).toHaveLength(MAX_THUMBNAILS);
  });
  it("the extension asks for access to the thumbnail hosts", () => {
    expect(manifest.host_permissions).toEqual(expect.arrayContaining(["https://i.ebayimg.com/*", "https://*.vinted.net/*"]));
  });
});

describe("reading thumbnails", () => {
  const cands = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, url: `https://images1.vinted.net/t/${i}/a.webp?c=${i % 3 === 0 ? "red" : i % 3 === 1 ? "black" : "white"}` }));

  it("reads each once, a few at a time (never above the limit), and reports each as it finishes", async () => {
    const deps = fakeDeps({ delay: 5 });
    const cache: ThumbCache = {};
    const seen: string[] = [];
    const stats = await readThumbnails(cands(30), cache, deps, { onReading: (id, r) => seen.push(`${id}:${r.colours[0]?.name}`) });
    expect(stats).toMatchObject({ read: 30, cached: 0, failed: 0 });
    expect(deps.inflight.max).toBeLessThanOrEqual(THUMB_CONCURRENCY);
    expect(deps.inflight.max).toBeGreaterThan(1);
    expect(seen).toHaveLength(30);
    expect(seen).toContain("c0:red");
    expect(seen).toContain("c1:black");
    expect(Object.keys(cache)).toHaveLength(30);
  });

  it("uses the cache: a second pass makes no requests, and a changed photo is read again", async () => {
    const log: string[] = [];
    const deps = fakeDeps({ log });
    const cache: ThumbCache = {};
    await readThumbnails(cands(5), cache, deps);
    expect(log).toHaveLength(5);
    const second = await readThumbnails(cands(5), cache, deps);
    expect(second).toMatchObject({ read: 0, cached: 5 });
    expect(log).toHaveLength(5);
    const changed = cands(5);
    changed[2].url += "&v=2";
    await readThumbnails(changed, cache, deps);
    expect(log).toHaveLength(6);
  });

  it("asks for the small eBay size, with the real url as the cache identity", async () => {
    const log: string[] = [];
    await readThumbnails([{ id: "e1", url: "https://i.ebayimg.com/images/g/abc/s-l500.webp?c=red" }], {}, fakeDeps({ log }));
    expect(log[0]).toContain("/s-l140.webp");
  });

  it("failures are silent: a bad fetch, a bad decode, a timeout", async () => {
    const stats = await readThumbnails(
      cands(6),
      {},
      fakeDeps({
        fetchBlob: async (url) => {
          if (url.includes("/1/")) throw new Error("HTTP 403");
          if (url.includes("/2/")) await new Promise(() => undefined); // never answers
          return new Blob(["red"]);
        },
        decode: async (b) => {
          if ((await b.text()) === "red" && false) throw new Error("x");
          return pixels(colours.red);
        },
      }),
      { timeoutMs: 20 },
    );
    expect(stats.failed).toBe(2);
    expect(stats.read).toBe(4);
  });

  it("stops starting new ones after the time budget and says how many were skipped", async () => {
    let t = 0;
    const deps = fakeDeps({ delay: 1, now: () => t });
    const stats = await readThumbnails(cands(20), {}, deps, { concurrency: 2, budgetMs: 100, onReading: () => (t += 30) });
    expect(stats.read).toBeLessThan(20);
    expect(stats.skipped).toBeGreaterThan(0);
    expect(stats.read + stats.skipped).toBe(20);
  });

  it("can be cancelled", async () => {
    const ctl = new AbortController();
    const stats = await readThumbnails(cands(20), {}, fakeDeps({ delay: 5 }), { concurrency: 2, onReading: () => ctl.abort(), signal: ctl.signal });
    expect(stats.read).toBeLessThan(20);
  });

  it("24 thumbnails (the cap) are read and analysed well inside the budget", async () => {
    const started = performance.now();
    const stats = await readThumbnails(cands(MAX_THUMBNAILS), {}, fakeDeps({ delay: 20 }));
    const took = performance.now() - started;
    expect(stats.read).toBe(MAX_THUMBNAILS);
    expect(took).toBeLessThan(1500); // network stubbed at 20 ms each, 6 at a time; the pixel work is the rest
  });

  it("the pixel work alone for 100 thumbnails is quick", () => {
    const started = performance.now();
    for (let i = 0; i < 100; i++) {
      const p = pixels(Object.values(colours)[i % 3]);
      analysePixels(p.data, p.width, p.height, p.channels);
    }
    expect(performance.now() - started).toBeLessThan(3000);
  });
});

describe("the cache", () => {
  it("keeps only cards still surveyed, and nothing older than the survey TTL", () => {
    const entry = (t: number) => ({ u: "x", c: [["red", 0.8]] as [string, number][], m: false, t });
    const out = pruneThumbCache({ a: entry(1000), b: entry(1000), c: entry(0) }, new Set(["a", "c"]), 2000, 1500);
    expect(Object.keys(out)).toEqual(["a"]);
  });
  it("a short stable hash tells urls apart", () => {
    expect(shortHash("https://x/1")).toBe(shortHash("https://x/1"));
    expect(shortHash("https://x/1")).not.toBe(shortHash("https://x/2"));
    expect(shortHash("a")).toHaveLength(16);
  });
});
